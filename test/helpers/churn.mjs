// Rewrites a multifile in a tight loop until a stop file appears. Runs as its
// own process so it can interleave with synchronous reads in the test process.
import fs from 'node:fs';
const [, , MF, STOP] = process.argv;
const base = fs.readFileSync(MF);
while (!fs.existsSync(STOP)) {
  const b = Buffer.from(base);
  b.writeFloatLE(Math.random(), 0);
  fs.writeFileSync(MF, b);
}
