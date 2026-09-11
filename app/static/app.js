const $ = (id) => document.getElementById(id);

let currentSessionId = null;

function showView(name) {
  $("auth-view").hidden = name !== "auth";
  $("chat-view").hidden = name !== "chat";
}

function addTurn(role, text) {
  const el = document.createElement("div");
  el.className = `turn ${role}`;
  el.textContent = text;
  $("transcript").appendChild(el);
  el.scrollIntoView({ block: "end" });
  return el;
}

// --- auth view: login/register toggle -------------------------------------

$("show-register").addEventListener("click", (e) => {
  e.preventDefault();
  $("login-form").hidden = true;
  $("register-form").hidden = false;
  $("show-register").hidden = true;
  $("show-login").hidden = false;
});

$("show-login").addEventListener("click", (e) => {
  e.preventDefault();
  $("register-form").hidden = true;
  $("login-form").hidden = false;
  $("show-login").hidden = true;
  $("show-register").hidden = false;
});

$("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("login-error").textContent = "";
  const form = new FormData(e.target);
  // fastapi-users' login route is OAuth2PasswordRequestForm: form-encoded
  // username/password, not JSON -- URLSearchParams matches that shape.
  const body = new URLSearchParams({
    username: form.get("email"),
    password: form.get("password"),
  });
  const res = await fetch("/auth/login", { method: "POST", body });
  if (!res.ok) {
    $("login-error").textContent = "Wrong email or password.";
    return;
  }
  await enterChat();
});

$("register-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("register-error").textContent = "";
  const form = new FormData(e.target);
  const email = form.get("email");
  const password = form.get("password");

  const res = await fetch("/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    $("register-error").textContent = body.detail ?? "Registration failed.";
    return;
  }
  // Registering doesn't log you in -- follow up with the same login call.
  const loginBody = new URLSearchParams({ username: email, password });
  const loginRes = await fetch("/auth/login", { method: "POST", body: loginBody });
  if (!loginRes.ok) {
    $("register-error").textContent = "Account created -- please sign in.";
    $("show-login").click();
    return;
  }
  await enterChat();
});

$("logout-button").addEventListener("click", async () => {
  await fetch("/auth/logout", { method: "POST" });
  currentSessionId = null;
  $("transcript").innerHTML = "";
  $("session-list").innerHTML = "";
  showView("auth");
});

// --- chat view --------------------------------------------------------------

async function pickOrCreateSession(sessions) {
  if (sessions.length > 0) {
    // Resume-most-recent policy: no session picker yet (deferred feature),
    // so "most recently updated" stands in for "the one you were just in."
    sessions.sort((a, b) => b.last_update_time - a.last_update_time);
    return sessions[0].session_id;
  }
  const createRes = await fetch("/sessions", { method: "POST" });
  const { session_id } = await createRes.json();
  return session_id;
}

async function resolveSession() {
  const res = await fetch("/sessions");
  if (!res.ok) throw new Error(`GET /sessions failed: ${res.status}`);
  const { sessions } = await res.json();
  return pickOrCreateSession(sessions);
}

class SessionMissingError extends Error {}

async function loadTranscript(sessionId) {
  const res = await fetch(`/sessions/${sessionId}/messages`);
  if (res.status === 404) throw new SessionMissingError();
  if (!res.ok) throw new Error(`GET .../messages failed: ${res.status}`);
  const { turns } = await res.json();
  $("transcript").innerHTML = "";
  for (const turn of turns) addTurn(turn.role, turn.text);
}

async function showChatFor(sessionId) {
  try {
    await loadTranscript(sessionId);
  } catch (err) {
    if (err instanceof SessionMissingError) {
      // The listed session no longer exists server-side -- most likely the
      // in-memory store was reset by a server restart since it was listed.
      // Self-heal instead of stranding the user: start a fresh session.
      const createRes = await fetch("/sessions", { method: "POST" });
      const created = await createRes.json();
      sessionId = created.session_id;
      $("transcript").innerHTML = "";
    } else {
      console.error(err);
      addTurn("assistant", "(couldn't load earlier messages -- see console)");
    }
  }
  // Runs unconditionally, success or degraded-recovery alike -- the view
  // transition is not allowed to depend on the history fetch succeeding.
  currentSessionId = sessionId;
  $("session-label").textContent = `session ${sessionId.slice(0, 8)}`;
  showView("chat");
  await refreshSidebar();
}

// --- sidebar: session picker (list, new chat, rename, delete) --------------

let sidebarSessions = [];

function renderSidebar(sessions) {
  sessions.sort((a, b) => b.last_update_time - a.last_update_time);
  sidebarSessions = sessions;
  const list = $("session-list");
  list.innerHTML = "";

  for (const session of sessions) {
    const li = document.createElement("li");
    li.className = "session-item" + (session.session_id === currentSessionId ? " active" : "");

    const titleEl = document.createElement("span");
    titleEl.className = "title";
    titleEl.textContent = session.title || "Untitled";
    titleEl.title = session.title || "Untitled"; // full text on hover, since it's ellipsized
    titleEl.addEventListener("click", () => showChatFor(session.session_id));

    const renameBtn = document.createElement("button");
    renameBtn.className = "icon-button";
    renameBtn.type = "button";
    renameBtn.textContent = "✎";
    renameBtn.title = "Rename";
    renameBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      startRename(li, titleEl, session);
    });

    const deleteBtn = document.createElement("button");
    deleteBtn.className = "icon-button";
    deleteBtn.type = "button";
    deleteBtn.textContent = "✕";
    deleteBtn.title = "Delete";
    deleteBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      deleteSessionFromSidebar(session.session_id);
    });

    li.append(titleEl, renameBtn, deleteBtn);
    list.appendChild(li);
  }
}

function startRename(li, titleEl, session) {
  const input = document.createElement("input");
  input.className = "title-input";
  input.value = session.title || "";
  input.placeholder = "New chat";

  const commit = async () => {
    const newTitle = input.value.trim();
    input.removeEventListener("blur", commit);
    if (newTitle && newTitle !== session.title) {
      await fetch(`/sessions/${session.session_id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: newTitle }),
      });
    }
    await refreshSidebar();
  };

  input.addEventListener("blur", commit);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") input.blur();
    if (e.key === "Escape") { input.removeEventListener("blur", commit); refreshSidebar(); }
  });

  li.replaceChild(input, titleEl);
  input.focus();
  input.select();
}

async function deleteSessionFromSidebar(sessionId) {
  if (!confirm("Delete this session? This can't be undone.")) return;
  await fetch(`/sessions/${sessionId}`, { method: "DELETE" });

  if (sessionId === currentSessionId) {
    // Same fallback as everywhere else: most recent remaining, or a fresh
    // session if none are left -- resolveSession() already encodes exactly
    // that policy, no new logic needed here.
    await showChatFor(await resolveSession());
  } else {
    await refreshSidebar();
  }
}

function updateSidebarTitle(sessionId, title) {
  // No refetch -- the title request's own response already has the answer.
  // Mutate the in-memory list renderSidebar last drew from and redraw.
  const match = sidebarSessions.find((s) => s.session_id === sessionId);
  if (match) {
    match.title = title;
    renderSidebar(sidebarSessions);
  }
}

async function refreshSidebar() {
  const res = await fetch("/sessions");
  if (!res.ok) return;
  const { sessions } = await res.json();
  renderSidebar(sessions);
}

$("new-chat-button").addEventListener("click", async () => {
  // Deliberately bypasses resolveSession()'s "resume most recent" policy --
  // this button's entire purpose is to *not* resume anything.
  const res = await fetch("/sessions", { method: "POST" });
  const { session_id } = await res.json();
  await showChatFor(session_id);
});

async function enterChat() {
  try {
    await showChatFor(await resolveSession());
  } catch (err) {
    console.error(err);
    $("login-error").textContent = "Something went wrong loading your chat -- see console.";
  }
}

$("chat-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = $("chat-input");
  const message = input.value.trim();
  if (!message) return;

  const isFirstTurn = $("transcript").children.length === 0;
  const sessionId = currentSessionId; // captured now, not read again later --

  addTurn("user", message);
  input.value = "";
  input.disabled = true;

  // if (isFirstTurn) {
  //   try {
  //     const titleRes = await fetch(`/sessions/${sessionId}/title`, {
  //       method: "POST",
  //       headers: { "Content-Type": "application/json" },
  //       body: JSON.stringify({ message }),
  //     });
  //     if (titleRes.ok) {
  //       const data = await titleRes.json();
  //       updateSidebarTitle(sessionId, data.title);
  //     }
  //   } catch (err) {
  //     console.error("title generation failed:", err);
  //   }
  // }

  try {
    const res = await fetch("/chat/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: sessionId, message }),
    });
    if (!res.ok) {
      addTurn("assistant", "(error -- see console)");
      console.error(await res.text());
      return;
    }

    const bubble = addTurn("assistant", "");
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bubble.textContent += decoder.decode(value, { stream: true });
      bubble.scrollIntoView({ block: "end" });
    }
  } finally {
    input.disabled = false;
    input.focus();
  }
});

// --- entry point --------------------------------------------------------------

(async function init() {
  const res = await fetch("/sessions");
  if (res.status === 401) {
    showView("auth");
    return;
  }
  if (!res.ok) {
    console.error(`GET /sessions failed: ${res.status}`);
    showView("auth");
    return;
  }
  const { sessions } = await res.json();
  try {
    await showChatFor(await pickOrCreateSession(sessions));
  } catch (err) {
    console.error(err);
    showView("auth");
  }
})();