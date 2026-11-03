"use strict";

// The feedback form. It only talks to window.feedback (preload.js); the main
// process does the sending, copying and opening.
(async () => {
  const $ = (id) => document.getElementById(id);
  const api = window.feedback;
  const ctx = await api.context();
  const isBug = ctx.type === "bug";

  document.title = ctx.title;
  $("heading").textContent = ctx.title;
  $("steps-field").hidden = !isBug;
  $("description-label").textContent = isBug ? "What happened?" : "What would you like?";
  $("title").placeholder = isBug ? "Short summary of the problem" : "Short summary of the idea";
  $("description").placeholder = isBug
    ? "What you did, what you expected, and what happened instead."
    : "What it would do, and how it would help.";
  $("title").maxLength = ctx.limits.title.max;
  $("description").maxLength = ctx.limits.description.max;
  $("steps").maxLength = ctx.limits.steps.max;
  $("system-lines").textContent = ctx.systemLines.join("\n");

  const fields = () => ({
    title: $("title").value,
    description: $("description").value,
    steps: isBug ? $("steps").value : "",
    includeSystem: $("include-system").checked,
    website: $("website").value,
  });

  // --- what will be sent --------------------------------------------------
  function showSystem() {
    const on = $("include-system").checked;
    $("system-lines").hidden = !on;
    $("system-off").hidden = on;
  }
  let previewTimer = null;
  async function refreshPreview() {
    if (!$("preview").open) return;
    $("preview-text").textContent = await api.preview(fields());
  }
  function changed() {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(refreshPreview, 150);
  }
  $("include-system").addEventListener("change", () => {
    showSystem();
    changed();
  });
  $("preview").addEventListener("toggle", refreshPreview);
  for (const id of ["title", "description", "steps"]) {
    $(id).addEventListener("input", () => {
      $(id).closest(".field").classList.remove("invalid");
      const hint = $(`${id}-error`);
      if (hint) hint.hidden = true;
      changed();
    });
  }
  showSystem();

  // --- submitting -------------------------------------------------------
  function check() {
    let ok = true;
    for (const id of ["title", "description"]) {
      const min = ctx.limits[id].min;
      const valid = $(id).value.trim().length >= min;
      $(id).closest(".field").classList.toggle("invalid", !valid);
      const hint = $(`${id}-error`);
      hint.hidden = valid;
      hint.textContent = id === "title" ? `Add a title (at least ${min} characters).` : `Describe it in at least ${min} characters.`;
      if (!valid && ok) $(id).focus();
      ok = ok && valid;
    }
    return ok;
  }

  function setBusy(busy) {
    for (const el of document.querySelectorAll("input, textarea, button")) el.disabled = busy;
    $("submit").textContent = busy ? "Posting…" : "Post to GitHub";
  }

  $("form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!check()) return;
    $("failure").hidden = true;
    $("fallback-note").hidden = true;
    setBusy(true);
    const result = await api.submit(fields());
    setBusy(false);
    if (result.ok) {
      $("issue-link").textContent = `issue #${result.number}`;
      $("issue-url").textContent = result.url;
      $("form-view").hidden = true;
      $("done-view").hidden = false;
      $("done").focus();
      return;
    }
    $("failure-text").textContent = result.message;
    $("failure").hidden = false;
    $("failure").scrollIntoView({ block: "nearest" });
  });

  // --- the ways out when it fails ----------------------------------------
  $("copy").addEventListener("click", async () => {
    await api.copy(fields());
    $("copy").textContent = "Copied";
    setTimeout(() => ($("copy").textContent = "Copy report"), 1500);
  });
  $("open-github").addEventListener("click", async () => {
    const { truncated } = await api.openOnGitHub(fields());
    $("fallback-note").textContent = truncated
      ? "Opened GitHub in your browser. The report was too long for a link, so it was cut short there; the full text is on your clipboard to paste in."
      : "Opened GitHub in your browser with the report filled in. Sign in there to post it.";
    $("fallback-note").hidden = false;
    $("fallback-note").scrollIntoView({ block: "nearest" });
  });

  $("issue-link").addEventListener("click", () => api.openIssue());
  $("cancel").addEventListener("click", () => api.close());
  $("done").addEventListener("click", () => api.close());
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") api.close();
  });

  $("title").focus();
})();
