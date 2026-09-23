const gist = "https://api.github.com/gists/503f33e56fddff3c2940f0bb1b9fc987";
const status = document.getElementById("status");
const retry = document.getElementById("retry");
const token = new URLSearchParams(location.hash.slice(1)).get("share");

async function openWorkspace() {
  retry.hidden = true;
  if (!token || !/^[A-Za-z0-9_-]{24}$/.test(token)) {
    status.textContent = "Open the private team link from your Covenant setup file.";
    return;
  }

  status.textContent = "Finding the current team workspace...";
  try {
    const response = await fetch(`${gist}?t=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) throw new Error("Address lookup unavailable");
    const data = await response.json();
    const origin = data.files?.["quire-origin.txt"]?.content?.trim();
    const target = new URL(origin);
    if (target.protocol !== "https:" || !/^[a-z0-9-]+\.trycloudflare\.com$/.test(target.hostname)
        || target.pathname !== "/" || target.search || target.hash) {
      throw new Error("Invalid workspace address");
    }
    target.searchParams.set("share", token);
    location.replace(target.href);
  } catch {
    status.textContent = "The team workspace is temporarily unavailable. Try again shortly.";
    retry.hidden = false;
  }
}

retry.addEventListener("click", openWorkspace);
openWorkspace();
