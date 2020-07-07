// Copyright (c) Brock Allen & Dominick Baier. All rights reserved.
// Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.

import { Log } from './Log.js';

export class SilentRenewService {

    constructor(userManager, idleTimerCtor, retryInterval) {
        this._userManager = userManager;
        this._idleTimerCtor = idleTimerCtor;
        this._retryInterval = retryInterval;
        this._initState();
    }

    _initState() {
        this._paused = false;
        this._expiringDuringPaused = false;
    }

    start() {
        if (!this._callback && !this._expiredCallback) {
            this._initState();
            this._callback = this._tokenExpiring.bind(this);
            this._expiredCallback = this._tokenExpired.bind(this);
            this._userManager.events.addAccessTokenExpiring(this._callback);
            this._userManager.events.addAccessTokenExpired(this._expiredCallback);

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
                    this._renew();
                }
            });
        }
    }

    stop() {
        if (this._callback) {
            this._userManager.events.removeAccessTokenExpiring(this._callback);
            this._userManager.events.removeAccessTokenExpired(this._expiredCallback);
            delete this._callback;
            delete this._expiredCallback;

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

        this._renew();
    }

    _tokenExpired() {
        this._expiringDuringPaused = false;

        if (this._retryHandle) {
            clearTimeout(this._retryHandle);
            delete this._retryHandle;
        }
    }

    _renew() {
        this._userManager.signinSilent().then(user => {
            Log.debug("SilentRenewService._tokenExpiring: Silent token renewal successful");
        }, err => {
            Log.error("SilentRenewService._tokenExpiring: Error from signinSilent:", err.message);
            this._userManager.events._raiseSilentRenewError(err);

            // schedule a retry
            if (this._retryInterval > 0) {
                this._retryHandle = setTimeout(() => {
                    this._renew();
                }, this._retryInterval);
            }
        });
    }
}
