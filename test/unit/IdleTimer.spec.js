import { IdleTimer } from '../../src/IdleTimer';

import chai from 'chai';
chai.should();

describe("IdleTimer", function () {

    it("should never go idle when the timeout is 0", function (done) {
        let idle = false;
        const timer = IdleTimer(0)(() => { idle = true; }, () => {});
        setTimeout(() => {
            idle.should.equal(false);
            timer.unbind();
            done();
        }, 10);
    });
});
