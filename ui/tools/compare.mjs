// Pixel comparison of two screenshots of the same screen: how many pixels differ in any channel,
// by how much at most, and the box they fall in; writes <out>/<name>-diff.png, the first shot
// dimmed with every differing pixel in red.
//   node ui/tools/compare.mjs <a.png> <b.png> <diff.png>
import sharp from 'sharp';

const [a, b, out] = process.argv.slice(2);
const load = (f) => sharp(f).removeAlpha().raw().toBuffer({ resolveWithObject: true });
const [A, B] = await Promise.all([load(a), load(b)]);
if (A.info.width !== B.info.width || A.info.height !== B.info.height) {
  console.log(`sizes differ: ${A.info.width}x${A.info.height} vs ${B.info.width}x${B.info.height}`);
  process.exit(1);
}
const { width: w, height: h } = A.info;
const diff = Buffer.alloc(w * h * 3);
let n = 0, most = 0, x0 = w, y0 = h, x1 = -1, y1 = -1;
for (let i = 0, p = 0; p < w * h; p++, i += 3) {
  const d = Math.max(Math.abs(A.data[i] - B.data[i]), Math.abs(A.data[i + 1] - B.data[i + 1]), Math.abs(A.data[i + 2] - B.data[i + 2]));
  if (d) {
    n++;
    most = Math.max(most, d);
    const x = p % w, y = (p / w) | 0;
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
    diff[i] = 255; diff[i + 1] = 0; diff[i + 2] = 0;
  } else {
    diff[i] = A.data[i] >> 2; diff[i + 1] = A.data[i + 1] >> 2; diff[i + 2] = A.data[i + 2] >> 2;
  }
}
if (out) await sharp(diff, { raw: { width: w, height: h, channels: 3 } }).png().toFile(out);
console.log(n ? `${n} of ${w * h} pixels differ, by at most ${most} a channel, within x ${x0}-${x1}, y ${y0}-${y1} (device px)`
  : `0 of ${w * h} pixels differ`);
