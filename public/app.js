/* scurt UI: talks to the same-origin API. The access token lives only in a
   JS variable (never localStorage); on load we silently try /api/auth/refresh,
   which succeeds if the httpOnly refresh cookie is still valid — that's how a
   page reload stays "logged in" without exposing the long-lived token. */
(() => {
  const $ = (id) => document.getElementById(id);

  let accessToken = null;
  let authMode = "login"; // or "register"

  // ---- helpers ----
  async function api(path, { method = "GET", body, auth = false } = {}) {
    const headers = {};
    if (body) headers["content-type"] = "application/json";
    if (auth && accessToken) headers.authorization = `Bearer ${accessToken}`;
    const res = await fetch(path, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      credentials: "same-origin",
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    return { ok: res.ok, status: res.status, data };
  }

  function show(el, on = true) {
    el.hidden = !on;
  }

  function setLoggedIn(email) {
    show($("account"), true);
    $("who").textContent = email;
    show($("auth-card"), false);
    show($("links-card"), true);
    show($("anon-note"), false);
    loadLinks();
  }

  function setLoggedOut() {
    accessToken = null;
    show($("account"), false);
    show($("auth-card"), true);
    show($("links-card"), false);
    show($("anon-note"), true);
  }

  // ---- shorten ----
  $("shorten-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    show($("shorten-error"), false);
    const body = { url: $("url-input").value.trim() };
    const slug = $("slug-input").value.trim();
    const ttl = $("ttl-input").value;
    if (slug) body.slug = slug;
    if (ttl) body.expiresInSeconds = Number(ttl);

    const { ok, data } = await api("/api/links", { method: "POST", body, auth: true });
    if (!ok) {
      $("shorten-error").textContent = data?.error ?? "eroare la scurtare";
      show($("shorten-error"), true);
      return;
    }
    const result = $("shorten-result");
    result.innerHTML = "";
    const a = document.createElement("a");
    a.href = data.shortUrl;
    a.textContent = data.shortUrl;
    a.target = "_blank";
    const copy = document.createElement("button");
    copy.className = "copy-btn";
    copy.textContent = "Copiază";
    copy.addEventListener("click", async () => {
      await navigator.clipboard.writeText(data.shortUrl);
      copy.textContent = "Copiat!";
      setTimeout(() => (copy.textContent = "Copiază"), 1500);
    });
    result.append(a, copy);
    show(result, true);
    $("url-input").value = "";
    $("slug-input").value = "";
    if (accessToken) loadLinks();
  });

  // ---- auth tabs ----
  function setAuthMode(mode) {
    authMode = mode;
    $("tab-login").classList.toggle("active", mode === "login");
    $("tab-register").classList.toggle("active", mode === "register");
    $("auth-submit").textContent = mode === "login" ? "Intră în cont" : "Creează cont";
    $("password-input").autocomplete = mode === "login" ? "current-password" : "new-password";
    show($("auth-error"), false);
  }
  $("tab-login").addEventListener("click", () => setAuthMode("login"));
  $("tab-register").addEventListener("click", () => setAuthMode("register"));

  $("auth-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    show($("auth-error"), false);
    const body = { email: $("email-input").value.trim(), password: $("password-input").value };
    const path = authMode === "login" ? "/api/auth/login" : "/api/auth/register";
    const { ok, data } = await api(path, { method: "POST", body });
    if (!ok) {
      const msg =
        data?.error === "invalid credentials"
          ? "Email sau parolă greșite."
          : data?.retryAfterSeconds
            ? `Cont blocat temporar. Reîncearcă în ${data.retryAfterSeconds}s.`
            : (data?.error ?? "eroare");
      $("auth-error").textContent = msg;
      show($("auth-error"), true);
      return;
    }
    accessToken = data.accessToken;
    $("password-input").value = "";
    setLoggedIn(data.user.email);
  });

  $("logout-btn").addEventListener("click", async () => {
    await api("/api/auth/logout", { method: "POST" });
    setLoggedOut();
  });

  // ---- my links ----
  async function loadLinks() {
    const { ok, data } = await api("/api/my/links", { auth: true });
    if (!ok) return;
    const body = $("links-body");
    body.innerHTML = "";
    const items = data.items ?? [];
    show($("links-empty"), items.length === 0);
    show($("links-table-wrap"), items.length > 0);
    for (const link of items) {
      const tr = document.createElement("tr");

      const shortTd = document.createElement("td");
      const a = document.createElement("a");
      a.href = link.shortUrl;
      a.textContent = "/" + link.slug;
      a.target = "_blank";
      shortTd.append(a);

      const destTd = document.createElement("td");
      destTd.className = "dest";
      destTd.title = link.targetUrl;
      destTd.textContent = link.targetUrl;

      const clicksTd = document.createElement("td");
      clicksTd.className = "num";
      clicksTd.textContent = String(link.clicks);

      const actionTd = document.createElement("td");
      const del = document.createElement("button");
      del.className = "link-delete";
      del.textContent = "Șterge";
      del.addEventListener("click", async () => {
        const res = await api(`/api/links/${link.slug}`, { method: "DELETE", auth: true });
        if (res.ok) loadLinks();
      });
      actionTd.append(del);

      tr.append(shortTd, destTd, clicksTd, actionTd);
      body.append(tr);
    }
  }

  // ---- on load: silent refresh ----
  (async () => {
    setAuthMode("login");
    const { ok, data } = await api("/api/auth/refresh", { method: "POST" });
    if (ok && data?.accessToken) {
      accessToken = data.accessToken;
      const me = await api("/api/me", { auth: true });
      if (me.ok) {
        setLoggedIn(me.data.email);
        return;
      }
    }
    setLoggedOut();
  })();
})();
