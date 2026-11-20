// Copyright (c) Brock Allen & Dominick Baier. All rights reserved.
// Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.

import { UserManager } from '../../src/UserManager';
import { Log } from '../../src/Log';
import { Global } from '../../src/Global';
import { UserManagerSettings } from '../../src/UserManagerSettings';
import { User } from '../../src/User';

import { StubMetadataService } from './StubMetadataService';
import { StubSilentRenewService } from './StubSilentRenewService';
import { StubStateStore } from './StubStateStore';
import { StubResponseValidator } from './StubResponseValidator';
import { StubTokenRevocationClient } from './StubTokenRevocationClient';

import chai from 'chai';
chai.should();
let assert = chai.assert;

describe("UserManager", function () {
    let settings;
    let subject;
    let stubMetadataService;
    let stubStateStore;
    let stubValidator;
    let stubSilentRenewService;
    let stubNavigator;
    let stubUserStore;
    let stubTokenRevocationClient;

    beforeEach(function () {

        Global._testing();

        Log.logger = console;
        Log.level = Log.NONE;

        stubNavigator = {};
        stubUserStore = new StubStateStore();
        stubStateStore = new StubStateStore();
        stubValidator = new StubResponseValidator();
        stubSilentRenewService = new StubSilentRenewService();
        stubMetadataService = new StubMetadataService();
        stubTokenRevocationClient = new StubTokenRevocationClient();

        settings = {
            authority: 'http://sts/oidc',
            client_id: 'client',
            monitorSession : false,
            navigator: stubNavigator,
            userStore: stubUserStore,
            stateStore: stubStateStore,
            ResponseValidatorCtor: () => stubValidator,
            MetadataServiceCtor: () => stubMetadataService
        };

        subject = new UserManager(settings,
            () => stubSilentRenewService,
            null,
            () => stubTokenRevocationClient);
    });

    describe("constructor", function () {

        it("should accept settings", function () {
            subject.settings.client_id.should.equal('client');
        });

    });

    describe("settings", function () {

        it("should be UserManagerSettings", function () {
            subject.settings.should.be.instanceof(UserManagerSettings);
        });

    });

    describe("userLoaded", function () {

        it("should be able to call getUser without recursion", function (done) {

            stubUserStore.item = new User({id_token:"id_token"}).toStorageString();

            subject.events.addUserLoaded(user => {
                subject.getUser().then(user => {
                    done();
                });
            });

            subject.events.load({});
        });

    });

    describe("signinSilent", function(){

        it("should pass silentRequestTimeout from settings", function(done) {

            stubUserStore.item = new User({id_token:"id_token"}).toStorageString();

            settings.silentRequestTimeout = 123;
            settings.silent_redirect_uri = "http://client/silent_callback";
            subject = new UserManager(settings);

            subject._signin = function(args, nav, navArgs){
                Log.debug("_signin", args, nav, navArgs);

                navArgs.silentRequestTimeout.should.equal(123);
                done();
                return Promise.resolve()
            }
            subject.signinSilent();
        });

        it("should pass silentRequestTimeout from params", function(done){

            stubUserStore.item = new User({id_token:"id_token"}).toStorageString();

            settings.silent_redirect_uri = "http://client/silent_callback";
            subject = new UserManager(settings);

            subject._signin = function(args, nav, navArgs){
                navArgs.silentRequestTimeout.should.equal(234);
                done();
                return Promise.resolve()
            }
            subject.signinSilent({silentRequestTimeout:234});
        });

        it("should pass prompt from params", function(done){

            stubUserStore.item = new User({id_token:"id_token"}).toStorageString();

            settings.silent_redirect_uri = "http://client/silent_callback";
            subject = new UserManager(settings);

            subject._signin = function(args, nav, navArgs){
                args.prompt.should.equal("foo");
                done();
                return Promise.resolve()
            }
            subject.signinSilent({prompt:"foo"});
        });

        it("should work when having no User present", function(done) {
            settings.silent_redirect_uri = "http://client/silent_callback";
            subject = new UserManager(settings);

            subject._signin = function(){
                done();
                return Promise.resolve()
            }
            subject.signinSilent({prompt:"foo"});
        })
    });

    describe("stale silent signin", function () {
        let loadedCount;
        let storedCount;
        let releaseSignin;

        function deferred() {
            let resolve;
            let start;
            const promise = new Promise(r => { resolve = r; });
            const started = new Promise(r => { start = r; });
            return { promise, resolve, started, start };
        }

        beforeEach(function () {
            settings.silent_redirect_uri = "http://client/silent_callback";
            subject = new UserManager(settings);
            loadedCount = 0;
            storedCount = 0;
            subject.events.addUserLoaded(() => { loadedCount++; });
            const set = stubUserStore.set.bind(stubUserStore);
            stubUserStore.set = (key, value) => { storedCount++; return set(key, value); };
            subject.processSigninResponse = () => Promise.resolve({ profile: { sub: "sub" }, access_token: "at" });
            const hold = deferred();
            releaseSignin = hold.resolve;
            subject._signin = (args) => hold.promise.then(() => subject._signinEnd("url", args));
        });

        function expectUnloaded(promise) {
            return promise.then(() => { throw new Error("should have rejected"); }, err => {
                err.message.should.equal("user_unloaded");
                loadedCount.should.equal(0);
                storedCount.should.equal(0);
            });
        }

        it("should reject an iframe signin that finishes after removeUser", function () {
            const signin = subject.signinSilent();
            return Promise.resolve().then(() => subject.removeUser()).then(() => {
                releaseSignin();
                return expectUnloaded(signin);
            });
        });

        it("should reject a refresh token signin that finishes after removeUser", function () {
            stubUserStore.item = new User({ id_token: "id_token", refresh_token: "rt", profile: { sub: "sub" } }).toStorageString();
            subject._tokenClient.exchangeRefreshToken = () => Promise.resolve({ access_token: "at2", id_token: "id_token2" });
            const validation = deferred();
            subject._validateIdTokenFromTokenRefreshToken = () => { validation.start(); return validation.promise; };
            const signin = subject.signinSilent();
            return validation.started.then(() => subject.removeUser()).then(() => {
                validation.resolve();
                return expectUnloaded(signin);
            });
        });

        it("should not send unloadCount to the token endpoint", function () {
            stubUserStore.item = new User({ id_token: "id_token", refresh_token: "rt", profile: { sub: "sub" } }).toStorageString();
            let tokenArgs;
            subject._tokenClient.exchangeRefreshToken = (args) => { tokenArgs = args; return Promise.resolve({ access_token: "at2" }); };
            return subject.signinSilent().then(() => {
                tokenArgs.refresh_token.should.equal("rt");
                tokenArgs.should.not.have.property("unloadCount");
            });
        });

        it("should reject a refresh token signin when removeUser finishes during the exchange", function () {
            stubUserStore.remove = () => { delete stubUserStore.item; return Promise.resolve(); };
            stubUserStore.item = new User({ id_token: "id_token", refresh_token: "rt", profile: { sub: "sub" } }).toStorageString();
            const exchange = deferred();
            subject._tokenClient.exchangeRefreshToken = () => { exchange.start(); return exchange.promise; };
            const signin = subject.signinSilent();
            return exchange.started.then(() => subject.removeUser()).then(() => {
                exchange.resolve({ access_token: "at2" });
                return expectUnloaded(signin);
            });
        });

        it("should store a silent signin with no removeUser", function () {
            const signin = subject.signinSilent();
            releaseSignin();
            return signin.then(user => {
                user.access_token.should.equal("at");
                loadedCount.should.equal(1);
                storedCount.should.equal(1);
            });
        });

        it("should store a redirect callback after removeUser", function () {
            return subject.removeUser()
                .then(() => subject.signinRedirectCallback("http://client/callback"))
                .then(() => loadedCount.should.equal(1));
        });
    });
});
