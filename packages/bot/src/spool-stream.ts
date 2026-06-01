// Resolves with the final byte offset when the stream ends (drop/EOF). Counts bytes so
// the offset matches the file's, advances only past complete (newline-terminated) lines
// (a torn trailing line stays buffered), and reports each line + the new offset.
export function consume(
  stream: NodeJS.ReadableStream,
  startOffset: number,
  onLine: (line: string) => void,
  onOffset: (offset: number) => void
): Promise<number> {
  return new Promise((resolve) => {
    let offset = startOffset;
    let buf = Buffer.alloc(0);

    stream.on("data", (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      let nl: number;
      while ((nl = buf.indexOf(0x0a)) !== -1) {
        const line = buf.subarray(0, nl);
        buf = buf.subarray(nl + 1);
        offset += line.length + 1;
        onLine(line.toString("utf8"));
      }
      onOffset(offset);
    });
    const done = () => resolve(offset);
    stream.on("end", done);
    stream.on("close", done);
    stream.on("error", done);
  });
}
