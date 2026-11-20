// Copyright (c) Brock Allen & Dominick Baier. All rights reserved.
// Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.

import { Log } from './Log.js';

const FinalErrors = [
    "invalid_request",
    "invalid_client",
    "invalid_grant",
    "unauthorized_client",
    "unsupported_grant_type",
    "invalid_scope",
    "interaction_required",
    "login_required",
    "account_selection_required",
    "consent_required",
    "invalid_request_uri",
    "invalid_request_object",
    "request_not_supported"
];
const MaxRetries = 3;

export class SilentRenewService {

    constructor(userManager, idleTimerCtor, retryInterval) {
        this._userManager = userManager;
        this._idleTimerCtor = idleTimerCtor;
        this._retryInterval = retryInterval;
        this._renewId = 0;
        this._initState();
    }

    _initState() {
        this._paused = false;
        this._expiringDuringPaused = false;
        this._expired = false;
    }

    start() {
        if (!this._callback && !this._expiredCallback) {
            this._initState();
            this._callback = this._tokenExpiring.bind(this);
            this._expiredCallback = this._tokenExpired.bind(this);
            this._unloadedCallback = this._userUnloaded.bind(this);
            this._userManager.events.addAccessTokenExpiring(this._callback);
            this._userManager.events.addAccessTokenExpired(this._expiredCallback);
            this._userManager.events.addUserUnloaded(this._unloadedCallback);

            // this will trigger loading of the user so the expiring events can be initialized
            this._userManager.getUser().then(user=>{
                // deliberate nop
            }).catch(err=>{
                // catch to suppress errors since we're in a ctor
                Log.error("SilentRenewService.start: Error from getUser:", err.message);
            });

            this._idleTimer = this._idleTimerCtor(() => {
                // on idle
                this._paused = true;
            }, () => {
                // on active
                this._paused = false;
                if (this._expiringDuringPaused) {
                    this._expiringDuringPaused = false;
                    this._startRenew();
                }
            });
        }
    }

    stop() {
        this._renewId++;
        if (this._callback) {
            this._userManager.events.removeAccessTokenExpiring(this._callback);
            this._userManager.events.removeAccessTokenExpired(this._expiredCallback);
            this._userManager.events.removeUserUnloaded(this._unloadedCallback);
            delete this._callback;
            delete this._expiredCallback;
            delete this._unloadedCallback;

            this._idleTimer.unbind();
            delete this._idleTimer;
        }

        if (this._retryHandle) {
            clearTimeout(this._retryHandle);
            delete this._retryHandle;
        }
    }

    _tokenExpiring() {
        if (this._paused) {
            Log.debug("SilentRenewService._tokenExpiring: skipped, user idle detected");
            this._expiringDuringPaused = true;
            return;
        }

        this._startRenew();
    }

    _tokenExpired() {
        if (this._expiringDuringPaused) {
            this._expiringDuringPaused = false;
            this._userManager.events._raiseSilentRenewFailed(new Error("expired_while_idle"));
        }
        this._expired = true;

        if (this._retryHandle) {
            clearTimeout(this._retryHandle);
            delete this._retryHandle;
            this._userManager.events._raiseSilentRenewFailed(this._lastError);
        }
    }

    _userUnloaded() {
        this._renewId++;

        if (this._retryHandle) {
            clearTimeout(this._retryHandle);
            delete this._retryHandle;
        }
    }

    _startRenew() {
        this._retryCount = 0;
        this._expired = false;
        this._renewId++;
        if (this._retryHandle) {
            clearTimeout(this._retryHandle);
            delete this._retryHandle;
        }
        this._renew(this._renewId);
    }

    _renew(renewId) {
        this._userManager.signinSilent().then(user => {
            Log.debug("SilentRenewService._tokenExpiring: Silent token renewal successful");
            if (renewId === this._renewId) {
                this._retryCount = 0;
            }
        }, err => {
            Log.error("SilentRenewService._tokenExpiring: Error from signinSilent:", err && err.message || err);
            if (renewId !== this._renewId) {
                return;
            }
            this._userManager.events._raiseSilentRenewError(err);
            this._lastError = err;

            const code = err && (err.error || err.message);
            const willRetry = this._retryInterval > 0 &&
                FinalErrors.indexOf(code) === -1 &&
                !this._expired &&
                this._retryCount < MaxRetries;
            if (!willRetry) {
                this._userManager.events._raiseSilentRenewFailed(err);
                return;
            }

            const delay = this._retryInterval * Math.pow(2, this._retryCount) * (1 + Math.random()) / 2;
            this._retryCount++;
            this._retryHandle = setTimeout(() => {
                delete this._retryHandle;
                this._renew(renewId);
            }, delay);
        });
    }
}
