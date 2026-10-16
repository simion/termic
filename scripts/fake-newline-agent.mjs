// Zero-token raw-mode fixture. Reports exactly which input bytes arrived,
// and models LF / backslash-return as newlines and plain CR as submit.
process.stdin.setRawMode(true);
process.stdin.resume();
let draft = "";
let submitted = "";
let submits = 0;
let bytes = [];

function report() {
  const state = JSON.stringify({ draft, submitted, submits, bytes });
  process.stdout.write(`\x1b]0;newline:${state}\x1b\\`);
}

process.stdin.on("data", chunk => {
  for (const byte of chunk) {
    if (byte === 0x03) process.exit(0);
    if (byte === 0x15) {
      draft = "";
      submitted = "";
      submits = 0;
      bytes = [];
      continue;
    }
    bytes.push(byte);
    if (byte === 0x0a) draft += "\n";
    else if (byte === 0x0d && draft.endsWith("\\")) draft = draft.slice(0, -1) + "\n";
    else if (byte === 0x0d) {
      submitted = draft;
      draft = "";
      submits++;
    } else draft += String.fromCharCode(byte);
  }
  report();
});
report();
