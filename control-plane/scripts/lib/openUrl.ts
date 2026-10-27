// Opens a page in the user's browser, best effort: the scripts always print
// the link as well, for a machine with no browser.
export function openUrl(url: string): void {
  const cmd = process.platform === "darwin" ? "open" : "xdg-open";
  try {
    Bun.spawn([cmd, url], { stdin: "ignore", stdout: "ignore", stderr: "ignore" }).exited.catch(
      () => {},
    );
  } catch {
    // no opener on this machine
  }
}
