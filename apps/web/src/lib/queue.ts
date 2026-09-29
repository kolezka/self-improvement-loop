// A queue entry's result line reads the same text ("done", "failed: ...")
// across buckets, so the CSS class has to come from the bucket, not the
// text: only the failed bucket is an error, done is just informational.
export function resultTextClass(bucketName: string): "error-text" | "muted" {
  return bucketName === "failed" ? "error-text" : "muted";
}
