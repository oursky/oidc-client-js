import { SilentRenewService } from '../../src/SilentRenewService';
import { ErrorResponse } from '../../src/ErrorResponse';

import chai from 'chai';
chai.should();

const MaxTimerRuns = 50;

describe("SilentRenewService", function () {
    let realSetTimeout;
    let realClearTimeout;
    let realRandom;
    let timers;
    let delays;
    let userManager;
    let idleCallbacks;
    let rejection;
    let pendingReject;
    let pendingResolve;
    let removeUserCount;
    let calls;
    let errorsRaised;
    let failures;
    let addUnloadedCount;

    function flush() {
        return new Promise(r => setImmediate(r));
    }

    function runAllTimers(runs = 0) {
        return flush().then(() => {
            if (timers.length === 0 || runs >= MaxTimerRuns) {
                return;
            }
            timers.shift().fn();
            return runAllTimers(runs + 1);
        });
    }

    function createSubject(retryInterval = 5000) {
        const subject = new SilentRenewService(userManager, (onIdle, onActive) => {
            idleCallbacks = { onIdle, onActive };
            return { unbind() {} };
        }, retryInterval);
        subject.start();
        return subject;
    }

    function holdNextRenew() {
        userManager.signinSilent = () => {
            calls++;
            userManager.signinSilent = defaultSigninSilent;
            return new Promise((resolve, reject) => { pendingResolve = resolve; pendingReject = reject; });
        };
    }

    function defaultSigninSilent() {
        calls++;
        return Promise.reject(rejection);
    }

    beforeEach(function () {
        realSetTimeout = global.setTimeout;
        realClearTimeout = global.clearTimeout;
        realRandom = Math.random;
        Math.random = () => 0.5;
        timers = [];
        let nextId = 1;
        delays = [];
        global.setTimeout = (fn, delay) => {
            const id = nextId++;
            delays.push(delay);
            timers.push({ id, fn });
            return id;
        };
        global.clearTimeout = (id) => {
            timers = timers.filter(t => t.id !== id);
        };

        calls = 0;
        errorsRaised = 0;
        failures = [];
        addUnloadedCount = 0;
        removeUserCount = 0;
        rejection = new Error("Network Error");
        userManager = {
            events: {
                addAccessTokenExpiring(cb) { this.expiring = cb; },
                addAccessTokenExpired(cb) { this.expired = cb; },
                removeAccessTokenExpiring() { delete this.expiring; },
                removeAccessTokenExpired() { delete this.expired; },
                addUserUnloaded(cb) { this.unloaded = cb; addUnloadedCount++; },
                removeUserUnloaded() { delete this.unloaded; },
                _raiseSilentRenewError() { errorsRaised++; },
                _raiseSilentRenewFailed(e) { failures.push({ error: e, afterErrors: errorsRaised }); }
            },
            signinSilent: defaultSigninSilent,
            getUser() { return Promise.resolve(null); },
            removeUser() { removeUserCount++; return Promise.resolve(); }
        };
    });

    afterEach(function () {
        global.setTimeout = realSetTimeout;
        global.clearTimeout = realClearTimeout;
        Math.random = realRandom;
    });

    it("should not retry invalid_grant", function () {
        rejection = new Error("invalid_grant");
        createSubject();
        userManager.events.expiring();
        return runAllTimers().then(() => calls.should.equal(1));
    });

    it("should not retry login_required", function () {
        rejection = new ErrorResponse({ error: "login_required" });
        createSubject();
        userManager.events.expiring();
        return runAllTimers().then(() => calls.should.equal(1));
    });

    it("should stop after 3 retries", function () {
        createSubject();
        userManager.events.expiring();
        return runAllTimers().then(() => calls.should.equal(4));
    });

    it("should double the retry delay each time", function () {
        createSubject();
        userManager.events.expiring();
        return runAllTimers().then(() => delays.should.deep.equal([3750, 7500, 15000]));
    });

    it("should keep at least half the delay with the lowest jitter", function () {
        Math.random = () => 0;
        createSubject();
        userManager.events.expiring();
        return runAllTimers().then(() => delays.should.deep.equal([2500, 5000, 10000]));
    });

    it("should restart the retry delay on a new expiring event", function () {
        createSubject();
        userManager.events.expiring();
        return runAllTimers().then(() => {
            delays = [];
            userManager.events.expiring();
            return runAllTimers();
        }).then(() => delays.should.deep.equal([3750, 7500, 15000]));
    });

    it("should not retry a string rejection forever", function () {
        rejection = "No access token returned from token endpoint";
        createSubject();
        userManager.events.expiring();
        return runAllTimers().then(() => calls.should.equal(4));
    });

    it("should not retry after expiry during a renew", function () {
        createSubject();
        holdNextRenew();
        userManager.events.expiring();
        userManager.events.expired();
        pendingReject(new Error("Network Error"));
        return runAllTimers().then(() => calls.should.equal(1));
    });

    it("should not retry after stop during a renew", function () {
        const subject = createSubject();
        holdNextRenew();
        userManager.events.expiring();
        subject.stop();
        pendingReject(new Error("Network Error"));
        return runAllTimers().then(() => calls.should.equal(1));
    });

    it("should not retry when interval is 0", function () {
        createSubject(0);
        userManager.events.expiring();
        return runAllTimers().then(() => calls.should.equal(1));
    });

    it("should reset the retry count on a new expiring event", function () {
        createSubject();
        userManager.events.expiring();
        return runAllTimers().then(() => {
            userManager.events.expiring();
            return runAllTimers();
        }).then(() => calls.should.equal(8));
    });

    it("should reset the retry count on return from idle", function () {
        createSubject();
        userManager.events.expiring();
        return runAllTimers().then(() => {
            idleCallbacks.onIdle();
            userManager.events.expiring();
            idleCallbacks.onActive();
            return runAllTimers();
        }).then(() => calls.should.equal(8));
    });

    it("should raise silentRenewFailed when the token expires while idle", function () {
        createSubject();
        idleCallbacks.onIdle();
        userManager.events.expiring();
        userManager.events.expired();
        idleCallbacks.onActive();
        return runAllTimers().then(() => {
            calls.should.equal(0);
            failures.length.should.equal(1);
            failures[0].error.message.should.equal("expired_while_idle");
        });
    });

    it("should raise silentRenewError on each failure", function () {
        createSubject();
        userManager.events.expiring();
        return runAllTimers().then(() => errorsRaised.should.equal(4));
    });
    it("should raise silentRenewFailed once on invalid_grant", function () {
        rejection = new Error("invalid_grant");
        createSubject();
        userManager.events.expiring();
        return runAllTimers().then(() => {
            failures.length.should.equal(1);
            timers.length.should.equal(0);
            calls.should.equal(1);
        });
    });

    it("should raise silentRenewFailed after the last silentRenewError", function () {
        createSubject();
        userManager.events.expiring();
        return runAllTimers().then(() => {
            errorsRaised.should.equal(4);
            failures.length.should.equal(1);
            failures[0].afterErrors.should.equal(4);
        });
    });

    it("should not raise silentRenewFailed when a retry succeeds", function () {
        createSubject();
        userManager.signinSilent = () => {
            calls++;
            userManager.signinSilent = () => { calls++; return Promise.resolve({}); };
            return Promise.reject(rejection);
        };
        userManager.events.expiring();
        return runAllTimers().then(() => {
            failures.length.should.equal(0);
            calls.should.equal(2);
        });
    });

    it("should not raise silentRenewFailed after stop during a renew", function () {
        const subject = createSubject();
        holdNextRenew();
        userManager.events.expiring();
        subject.stop();
        pendingReject(new Error("Network Error"));
        return runAllTimers().then(() => failures.length.should.equal(0));
    });

    it("should raise silentRenewFailed after expiry during a renew", function () {
        createSubject();
        holdNextRenew();
        userManager.events.expiring();
        userManager.events.expired();
        pendingReject(new Error("Network Error"));
        return runAllTimers().then(() => failures.length.should.equal(1));
    });

    it("should raise silentRenewFailed when expiry cancels a waiting retry", function () {
        createSubject();
        userManager.events.expiring();
        return flush().then(() => {
            userManager.events.expired();
            return runAllTimers();
        }).then(() => {
            failures.length.should.equal(1);
            failures[0].error.message.should.equal("Network Error");
            calls.should.equal(1);
        });
    });

    it("should not raise silentRenewFailed on expiry with no renew", function () {
        createSubject();
        userManager.events.expired();
        return runAllTimers().then(() => failures.length.should.equal(0));
    });

    it("should raise silentRenewFailed when interval is 0", function () {
        createSubject(0);
        userManager.events.expiring();
        return runAllTimers().then(() => failures.length.should.equal(1));
    });

    it("should raise silentRenewFailed once when expiry hits an in-flight retry", function () {
        createSubject();
        userManager.events.expiring();
        return flush().then(() => {
            holdNextRenew();
            timers.shift().fn();
            userManager.events.expired();
            pendingReject(new Error("Network Error"));
            return runAllTimers();
        }).then(() => failures.length.should.equal(1));
    });

    it("should not raise silentRenewFailed on expiry after a retry succeeded", function () {
        createSubject();
        userManager.signinSilent = () => {
            calls++;
            userManager.signinSilent = () => { calls++; return Promise.resolve({}); };
            return Promise.reject(rejection);
        };
        userManager.events.expiring();
        return runAllTimers().then(() => {
            userManager.events.expired();
            failures.length.should.equal(0);
        });
    });

    it("should cancel a waiting retry on user unload", function () {
        createSubject();
        userManager.events.expiring();
        return flush().then(() => {
            userManager.events.unloaded();
            return runAllTimers();
        }).then(() => {
            timers.length.should.equal(0);
            calls.should.equal(1);
            failures.length.should.equal(0);
        });
    });

    it("should not retry after user unload during a renew", function () {
        createSubject();
        holdNextRenew();
        userManager.events.expiring();
        userManager.events.unloaded();
        pendingReject(new Error("Network Error"));
        return runAllTimers().then(() => {
            calls.should.equal(1);
            failures.length.should.equal(0);
        });
    });

    it("should retry again on a renew after user unload", function () {
        createSubject();
        holdNextRenew();
        userManager.events.expiring();
        userManager.events.unloaded();
        pendingReject(new Error("Network Error"));
        return runAllTimers().then(() => {
            userManager.events.expiring();
            return runAllTimers();
        }).then(() => calls.should.equal(5));
    });

    it("should not add the unload handler twice on restart", function () {
        const subject = createSubject();
        subject.start();
        subject.stop();
        (userManager.events.unloaded === undefined).should.equal(true);
        subject.start();
        addUnloadedCount.should.equal(2);
    });

    it("should ignore an attempt from before user unload in a new renew", function () {
        createSubject();
        holdNextRenew();
        userManager.events.expiring();
        userManager.events.unloaded();
        userManager.signinSilent = () => { calls++; return Promise.resolve({}); };
        userManager.events.expiring();
        pendingReject(new Error("invalid_grant"));
        return runAllTimers().then(() => {
            calls.should.equal(2);
            failures.length.should.equal(0);
        });
    });

    it("should ignore an attempt from before a restart in a new renew", function () {
        const subject = createSubject();
        holdNextRenew();
        userManager.events.expiring();
        subject.stop();
        subject.start();
        userManager.signinSilent = () => { calls++; return Promise.resolve({}); };
        userManager.events.expiring();
        pendingReject(new Error("invalid_grant"));
        return runAllTimers().then(() => failures.length.should.equal(0));
    });

    it("should ignore an attempt from before a restart with no new renew", function () {
        const subject = createSubject();
        holdNextRenew();
        userManager.events.expiring();
        subject.stop();
        subject.start();
        pendingReject(new Error("Network Error"));
        return runAllTimers().then(() => {
            calls.should.equal(1);
            failures.length.should.equal(0);
        });
    });

    it("should not retry or fail on a stale attempt rejected after user unload", function () {
        createSubject();
        holdNextRenew();
        userManager.events.expiring();
        userManager.events.unloaded();
        pendingReject(new Error("user_unloaded"));
        return runAllTimers().then(() => {
            calls.should.equal(1);
            failures.length.should.equal(0);
            removeUserCount.should.equal(0);
            errorsRaised.should.equal(0);
        });
    });

    it("should keep a user loaded by an attempt from before a new renew", function () {
        createSubject();
        holdNextRenew();
        userManager.events.expiring();
        userManager.events.expiring();
        pendingResolve({});
        return runAllTimers().then(() => removeUserCount.should.equal(0));
    });

    it("should not reset the retry count from an older attempt", function () {
        createSubject();
        holdNextRenew();
        userManager.events.expiring();
        userManager.events.expiring();
        return flush().then(() => {
            timers.shift().fn();
            return flush();
        }).then(() => {
            pendingResolve({});
            return runAllTimers();
        }).then(() => calls.should.equal(5));
    });
});
