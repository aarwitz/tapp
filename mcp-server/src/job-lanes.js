// Who is allowed to be running right now.
//
// A local Studio owns one simulator, one repository and one live session, so the operator's work
// is strictly one at a time. A public Studio has many visitors whose website audits share none of
// that — each drives its own browser and writes its own capture — so serializing them globally
// only makes a working Studio look broken to the second person through the door.
//
// Lanes are that distinction: the operator has one, every visitor has their own, and the machine
// keeps a ceiling because it is finite. The ceiling and a lane conflict are different answers:
// "busy, try again" is not the same as "your own run is still going".
export class JobLanes {
  constructor({ operatorLane = "operator", maxConcurrentGuests = 3 } = {}) {
    this.operatorLane = operatorLane;
    this.maxConcurrentGuests = maxConcurrentGuests;
    this.active = new Map();
  }

  get guestsRunning() {
    let count = 0;
    for (const lane of this.active.keys()) if (lane !== this.operatorLane) count += 1;
    return count;
  }

  running(lane) {
    return this.active.get(lane) || null;
  }

  /**
   * Take the lane, or explain why not. Returns `{ ok: true }`, or `{ ok: false, statusCode,
   * message }` — 409 when this lane is already working, 503 when the machine is at its ceiling.
   */
  claim(lane, job) {
    const busy = this.active.get(lane);
    if (busy) {
      return { ok: false, statusCode: 409, message: `Operation '${busy.operation}' is still running` };
    }
    if (lane !== this.operatorLane && this.guestsRunning >= this.maxConcurrentGuests) {
      return { ok: false, statusCode: 503, message: "This Studio is busy with other runs right now; try again in a minute." };
    }
    this.active.set(lane, job);
    return { ok: true };
  }

  // Releasing is idempotent and only ever clears the job that holds the lane, so a late
  // completion cannot free a lane someone else has since taken.
  release(lane, job) {
    if (this.active.get(lane) === job) this.active.delete(lane);
  }
}
