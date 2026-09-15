// Rewrites a multifile in a tight loop until a stop file appears. Runs as its
// own process so it can interleave with synchronous reads in the test process.
//
// The stop file is the normal exit, but it is written by a harness that can die
// first — a crash, a killed runner, a Ctrl-C between spawn and cleanup. The loop
// is synchronous, so timers never fire and signal handlers queue behind it:
// every way out has to be an inline check. Without these two, an abandoned run
// rewrites the file forever.
import fs from 'node:fs';
const [, , MF, STOP] = process.argv;
// A garbage override must not disable the deadline: NaN loses every
// comparison, which is exactly the immortal loop this is here to prevent.
const override = Number(process.env.CHURN_TIMEOUT_MS);
const TIMEOUT_MS = override > 0 ? override : 60000;
const DEADLINE = Date.now() + TIMEOUT_MS;
const PARENT = process.ppid;

// Reparenting (to init, or to a subreaper) is the reliable signal on POSIX; the
// signal-0 probe covers the rest and costs a syscall only once the pid looks
// unchanged.
function orphaned() {
  if (process.ppid !== PARENT) return true;
  try {
    process.kill(PARENT, 0);
    return false;
  } catch {
    return true;
  }
}

const base = fs.readFileSync(MF);
while (!fs.existsSync(STOP)) {
  if (Date.now() > DEADLINE || orphaned()) break;
  const b = Buffer.from(base);
  b.writeFloatLE(Math.random(), 0);
  fs.writeFileSync(MF, b);
}
