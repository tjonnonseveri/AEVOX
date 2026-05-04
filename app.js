// ================================================
//  AEVOX — Application JavaScript principale
//  Firebase Firestore + Realtime Database
// ================================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import {
	getFirestore,
	collection,
	doc,
	addDoc,
	setDoc,
	getDoc,
	getDocs,
	updateDoc,
	deleteDoc,
	query,
	where,
	orderBy,
	limit,
	onSnapshot,
	serverTimestamp,
	arrayUnion,
	arrayRemove,
	increment,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import {
	getAuth,
	createUserWithEmailAndPassword,
	signInWithEmailAndPassword,
	signOut,
	onAuthStateChanged,
	GoogleAuthProvider,
	signInWithCredential,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import {
	getDatabase,
	ref,
	set,
	push,
	onChildAdded,
	onValue,
	off,
	serverTimestamp as rts,
	get as rget,
	onDisconnect,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";

// ================================================
//  CONFIGURATION FIREBASE
// ================================================
const firebaseConfig = {
	apiKey: "AIzaSyA_z5FQQbeb7y6Msv9nzo-VxLtmTrTnQ4c",
	authDomain: "vox-app-b020e.firebaseapp.com",
	databaseURL:
		"https://vox-app-b020e-default-rtdb.europe-west1.firebasedatabase.app",
	projectId: "vox-app-b020e",
	storageBucket: "vox-app-b020e.firebasestorage.app",
	messagingSenderId: "99369128217",
	appId: "1:99369128217:web:0286bfdd90cc6c4709f588",
};

const firebaseApp = initializeApp(firebaseConfig);
const db = getFirestore(firebaseApp);
const auth = getAuth(firebaseApp);
const rtdb = getDatabase(firebaseApp);

// ================================================
//  ÉTAT GLOBAL
// ================================================
let currentUser = null; // données utilisateur connecté
let listeners = []; // listeners Firestore à nettoyer
let chatUnsub = null; // listener chat actif
let presenceRef = null; // référence présence RTDB
let typingTimeout = null; // timeout indicateur frappe
let searchTab = "users";

// ================================================
//  UTILITAIRES
// ================================================

/** Raccourci getElementById */
const $ = (id) => document.getElementById(id);

/** Échappe le HTML pour éviter les injections */
const esc = (s) =>
	String(s || "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");

/** Formate le contenu : @mentions et #hashtags en couleur */
const formatContent = (text) =>
	esc(text)
		.replace(/@(\w+)/g, '<span class="mention">@$1</span>')
		.replace(/#(\w+)/g, '<span class="hashtag">#$1</span>');

/** Calcule le temps relatif */
const timeAgo = (ts) => {
	if (!ts) return "";
	const ms = ts?.toMillis ? ts.toMillis() : +ts;
	const diff = Date.now() - ms;
	if (diff < 60000) return "À l'instant";
	if (diff < 3600000) return Math.floor(diff / 60000) + "m";
	if (diff < 86400000) return Math.floor(diff / 3600000) + "h";
	return Math.floor(diff / 86400000) + "j";
};

/** Génère le HTML d'un avatar */
const avatarHTML = (user, extraClass = "") =>
	`<div class="avatar ${extraClass}" style="background:${user?.avatarColor || "#7c6af7"}">
    ${
			user?.avatar
				? `<img src="${user.avatar}" alt="">`
				: (user?.name || "?")[0].toUpperCase()
		}
  </div>`;

/** Couleurs aléatoires pour les nouveaux comptes */
const COLORS = [
	"#7c6af7",
	"#4a9eff",
	"#5dd89e",
	"#f26b6b",
	"#f5a623",
	"#d46ef5",
];

// ================================================
//  PRÉSENCE EN LIGNE (Realtime Database)
// ================================================

function setOnline(uid) {
	presenceRef = ref(rtdb, `presence/${uid}`);
	set(presenceRef, { online: true, lastSeen: rts() });
	onDisconnect(presenceRef).set({ online: false, lastSeen: rts() });
	window.addEventListener("beforeunload", () => {
		set(presenceRef, { online: false, lastSeen: rts() });
	});
}

async function isOnline(uid) {
	try {
		const snap = await rget(ref(rtdb, `presence/${uid}`));
		return snap.exists() && snap.val().online === true;
	} catch {
		return false;
	}
}

/** Écoute tous les utilisateurs en ligne pour le panneau droit */
function listenOnlineUsers() {
	const onlineRef = ref(rtdb, "presence");
	onValue(onlineRef, (snap) => {
		const panel = $("online-panel");
		if (!panel) return;
		const data = snap.val() || {};
		const online = Object.entries(data).filter(
			([uid, v]) => v.online && uid !== currentUser?.id,
		);
		if (!online.length) {
			panel.innerHTML =
				'<p style="font-size:13px;color:var(--text3)">Personne en ligne.</p>';
			return;
		}
		panel.innerHTML = online
			.slice(0, 5)
			.map(
				([uid, v]) =>
					`<div style="display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid var(--border);cursor:pointer"
            onclick="V.go('chat',{uid:'${uid}',cid:''})">
        <div style="position:relative">
          <div class="avatar" style="background:#7c6af7;width:30px;height:30px;font-size:12px">
            ${v.name ? v.name[0].toUpperCase() : "?"}
          </div>
          <div class="online-dot" style="position:absolute;bottom:0;right:0;border:1.5px solid var(--bg2)"></div>
        </div>
        <div style="font-size:13px;font-weight:500">${esc(v.name || "Utilisateur")}</div>
      </div>`,
			)
			.join("");
	});
}

// ================================================
//  AUTHENTIFICATION
// ================================================

function showAuthMessage(msg, type = "error") {
	$("auth-msg").innerHTML =
		`<div class="alert alert-${type === "ok" ? "success" : "error"}">${msg}</div>`;
}

/** Crée le document utilisateur dans Firestore */
async function createUserDoc(uid, data) {
	const handle =
		(data.name || "user")
			.toLowerCase()
			.replace(/\s+/g, "")
			.replace(/[^a-z0-9]/g, "") + Math.floor(Math.random() * 999);

	const userDoc = {
		name: data.name || "",
		handle,
		email: data.email || "",
		bio: "",
		avatar: data.avatar || null,
		avatarColor: COLORS[Math.floor(Math.random() * COLORS.length)],
		role: "user",
		verified: !!data.googleSignIn,
		followers: [],
		following: [],
		banned: false,
		createdAt: serverTimestamp(),
	};
	await setDoc(doc(db, "users", uid), userDoc);

	// Le premier compte inscrit devient automatiquement admin
	const allUsers = await getDocs(collection(db, "users"));
	if (allUsers.size === 1) {
		await updateDoc(doc(db, "users", uid), { role: "admin" });
		userDoc.role = "admin";
	}
	return userDoc;
}

// ================================================
//  GOOGLE SIGN-IN
// ================================================

function initGoogleSignIn() {
	if (!window.google) {
		setTimeout(initGoogleSignIn, 400);
		return;
	}
	google.accounts.id.initialize({
		client_id:
			"867790391027-b5idb3338foevnoi9l9tqbg050f0udj5.apps.googleusercontent.com",
		callback: handleGoogleCredential,
		auto_select: false,
		cancel_on_tap_outside: true,
	});
	const renderBtn = (id) => {
		const el = $(id);
		if (el)
			google.accounts.id.renderButton(el, {
				theme: "outline",
				size: "large",
				width: 324,
				text: "continue_with",
				shape: "rectangular",
			});
	};
	renderBtn("g_login");
	renderBtn("g_register");
}

async function handleGoogleCredential(response) {
	try {
		const payload = JSON.parse(atob(response.credential.split(".")[1]));
		const credential = GoogleAuthProvider.credential(response.credential);
		const result = await signInWithCredential(auth, credential);
		const existing = await getDoc(doc(db, "users", result.user.uid));
		if (!existing.exists()) {
			await createUserDoc(result.user.uid, {
				name: payload.name,
				email: payload.email,
				avatar: payload.picture,
				googleSignIn: true,
			});
		}
	} catch (e) {
		showAuthMessage("Erreur Google : " + e.message);
	}
}

// ================================================
//  ÉTAT D'AUTHENTIFICATION (observer principal)
// ================================================

onAuthStateChanged(auth, async (firebaseUser) => {
	$("loading-screen").style.display = "none";
	if (firebaseUser) {
		const snap = await getDoc(doc(db, "users", firebaseUser.uid));
		if (!snap.exists()) {
			$("auth-screen").style.display = "flex";
			$("app").style.display = "none";
			initGoogleSignIn();
			return;
		}
		const data = snap.data();
		if (data.banned) {
			await signOut(auth);
			showAuthMessage("Ce compte a été suspendu.");
			return;
		}
		currentUser = { id: firebaseUser.uid, ...data };
		setOnline(firebaseUser.uid);
		$("auth-screen").style.display = "none";
		$("app").style.display = "block";
		V.updateSidebar();
		V.go("home");
		V.loadRightPanel();
		listenOnlineUsers();
	} else {
		currentUser = null;
		$("auth-screen").style.display = "flex";
		$("app").style.display = "none";
		$("loading-screen").style.display = "none";
		initGoogleSignIn();
	}
});

// ================================================
//  OBJET PRINCIPAL V (interface globale)
// ================================================

const V = (window.V = {
	// ---- AUTH ----

	switchTab(tab) {
		document.querySelectorAll(".auth-tab").forEach((el, i) => {
			el.classList.toggle(
				"active",
				(i === 0 && tab === "login") || (i === 1 && tab === "register"),
			);
		});
		$("login-form").style.display = tab === "login" ? "flex" : "none";
		$("register-form").style.display = tab === "register" ? "flex" : "none";
		$("auth-msg").innerHTML = "";
	},

	async login() {
		const email = $("l-email").value.trim();
		const pass = $("l-pass").value;
		if (!email || !pass) {
			showAuthMessage("Remplissez tous les champs.");
			return;
		}
		try {
			await signInWithEmailAndPassword(auth, email, pass);
		} catch (err) {
			const messages = {
				"auth/invalid-credential": "Email ou mot de passe incorrect.",
				"auth/user-not-found": "Compte introuvable.",
				"auth/wrong-password": "Mot de passe incorrect.",
			};
			showAuthMessage(messages[err.code] || err.message);
		}
	},

	async register() {
		const name = $("r-name").value.trim();
		const email = $("r-email").value.trim();
		const pass = $("r-pass").value;
		const confirm = $("r-conf").value;
		if (!name || !email || !pass) {
			showAuthMessage("Remplissez tous les champs.");
			return;
		}
		if (pass.length < 6) {
			showAuthMessage("Mot de passe trop court (6 min).");
			return;
		}
		if (pass !== confirm) {
			showAuthMessage("Les mots de passe ne correspondent pas.");
			return;
		}
		try {
			const result = await createUserWithEmailAndPassword(auth, email, pass);
			await createUserDoc(result.user.uid, { name, email });
		} catch (err) {
			const messages = {
				"auth/email-already-in-use": "Cet email est déjà utilisé.",
			};
			showAuthMessage(messages[err.code] || err.message);
		}
	},

	async logout() {
		// Mettre hors ligne avant de déconnecter
		if (presenceRef) set(presenceRef, { online: false, lastSeen: rts() });
		listeners.forEach((u) => u());
		listeners = [];
		if (chatUnsub) {
			chatUnsub();
			chatUnsub = null;
		}
		await signOut(auth);
	},

	// ---- SIDEBAR ----

	updateSidebar() {
		if (!currentUser) return;
		$("sb-name").textContent = currentUser.name;
		$("sb-handle").textContent = "@" + currentUser.handle;
		const avEl = $("sb-av");
		avEl.style.background = currentUser.avatarColor || "#7c6af7";
		avEl.innerHTML = currentUser.avatar
			? `<img src="${currentUser.avatar}" alt="">`
			: currentUser.name[0].toUpperCase();
		$("nav-admin").style.display =
			currentUser.role === "admin" ? "flex" : "none";
	},

	// ---- NAVIGATION ----

	go(page, data = null) {
		// Nettoyer les anciens listeners
		listeners.forEach((u) => u());
		listeners = [];
		if (chatUnsub) {
			chatUnsub();
			chatUnsub = null;
		}

		// Mettre à jour la navigation active
		document
			.querySelectorAll(".nav-item")
			.forEach((n) => n.classList.remove("active"));
		const navEl = $("nav-" + page);
		if (navEl) navEl.classList.add("active");

		// Afficher/cacher le panneau droit
		const rightPanel = $("right-panel");
		if (rightPanel) {
			rightPanel.style.display = [
				"home",
				"public",
				"profile",
				"search",
			].includes(page)
				? "block"
				: "none";
		}

		const content = $("page-content");
		switch (page) {
			case "home":
				this.renderHome(content);
				break;
			case "public":
				this.renderPublic(content);
				break;
			case "messages":
				this.renderMessages(content);
				break;
			case "chat":
				this.renderChat(content, data);
				break;
			case "groups":
				this.renderGroups(content);
				break;
			case "search":
				this.renderSearch(content);
				break;
			case "notifications":
				this.renderNotifications(content);
				break;
			case "profile":
				this.renderProfile(content, data || currentUser.id);
				break;
			case "settings":
				this.renderSettings(content);
				break;
			case "admin":
				this.renderAdmin(content);
				break;
			default:
				this.renderHome(content);
		}
	},

	// ---- ACCUEIL ----

	renderHome(el) {
		el.innerHTML = `
      <div class="main-inner">
        <div class="page-header">
          <div class="page-title">Accueil</div>
        </div>
        ${this.composeHTML()}
        <div id="feed-container">
          <div class="loading-screen" style="height:200px"><div class="spinner"></div></div>
        </div>
      </div>`;

		const q = query(
			collection(db, "posts"),
			orderBy("createdAt", "desc"),
			limit(40),
		);
		const unsub = onSnapshot(q, async (snap) => {
			const feed = $("feed-container");
			if (!feed) return;
			const posts = snap.docs
				.map((d) => ({ id: d.id, ...d.data() }))
				.filter(
					(p) =>
						p.type === "public" ||
						p.authorId === currentUser.id ||
						(p.type === "followers" &&
							(currentUser.following || []).includes(p.authorId)),
				);
			feed.innerHTML = posts.length
				? ""
				: '<div class="empty-state"><p>Aucune publication. Soyez le premier !</p></div>';
			for (const post of posts) {
				const div = document.createElement("div");
				div.innerHTML = await this.postHTML(post);
				feed.appendChild(div.firstChild);
			}
		});
		listeners.push(unsub);
	},

	// ---- PUBLIC ----

	renderPublic(el) {
		el.innerHTML = `
      <div class="main-inner">
        <div class="page-header">
          <div class="page-title">Public</div>
          <div class="page-subtitle">Toutes les publications publiques</div>
        </div>
        ${this.composeHTML()}
        <div id="feed-container">
          <div class="loading-screen" style="height:200px"><div class="spinner"></div></div>
        </div>
      </div>`;

		const q = query(
			collection(db, "posts"),
			where("type", "==", "public"),
			orderBy("createdAt", "desc"),
			limit(50),
		);
		const unsub = onSnapshot(q, async (snap) => {
			const feed = $("feed-container");
			if (!feed) return;
			feed.innerHTML = "";
			const posts = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
			if (!posts.length) {
				feed.innerHTML =
					'<div class="empty-state"><p>Aucune publication publique.</p></div>';
				return;
			}
			for (const post of posts) {
				const div = document.createElement("div");
				div.innerHTML = await this.postHTML(post);
				feed.appendChild(div.firstChild);
			}
		});
		listeners.push(unsub);
	},

	// ---- COMPOSEUR DE POST ----

	composeHTML() {
		return `
      <div class="compose-box" style="margin-top:16px">
        ${avatarHTML(currentUser)}
        <div class="compose-inner">
          <textarea id="compose-text"
            placeholder="Exprime-toi sur Aevox..."
            maxlength="280"
            oninput="V.updateCharCount(this)">
          </textarea>
          <div class="compose-footer">
            <select class="compose-select" id="compose-type">
              <option value="public">🌍 Public</option>
              <option value="followers">👥 Abonnés</option>
            </select>
            <div style="display:flex;align-items:center;gap:10px">
              <span class="char-count" id="char-count">280</span>
              <button class="btn-primary" style="padding:8px 18px;font-size:13px"
                onclick="V.submitPost()">Publier</button>
            </div>
          </div>
        </div>
      </div>`;
	},

	updateCharCount(textarea) {
		const left = 280 - textarea.value.length;
		const el = $("char-count");
		if (!el) return;
		el.textContent = left;
		el.style.color = left < 20 ? (left < 0 ? "#f26b6b" : "#f5a623") : "";
	},

	async submitPost() {
		const text = $("compose-text")?.value?.trim();
		if (!text || text.length > 280) return;
		const type = $("compose-type")?.value || "public";
		await addDoc(collection(db, "posts"), {
			authorId: currentUser.id,
			content: text,
			type,
			likes: [],
			commentCount: 0,
			createdAt: serverTimestamp(),
		});
		$("compose-text").value = "";
		if ($("char-count")) $("char-count").textContent = "280";
	},

	// ---- HTML D'UN POST ----

	async postHTML(post) {
		// Récupérer les infos de l'auteur
		let author = currentUser.id === post.authorId ? currentUser : null;
		if (!author) {
			try {
				const snap = await getDoc(doc(db, "users", post.authorId));
				author = snap.exists()
					? { id: snap.id, ...snap.data() }
					: { name: "Utilisateur", handle: "user", avatarColor: "#888" };
			} catch {
				author = { name: "?", handle: "?", avatarColor: "#888" };
			}
		}

		const isLiked = (post.likes || []).includes(currentUser.id);
		const canDelete =
			post.authorId === currentUser.id || currentUser.role === "admin";
		const badges = {
			public: '<span class="post-badge badge-public">🌍 Public</span>',
			followers: '<span class="post-badge badge-followers">👥 Abonnés</span>',
		};

		return `
      <div class="post" id="post-${post.id}">
        ${avatarHTML(author)}
        <div class="post-body">
          <div class="post-header">
            <span class="post-author" style="cursor:pointer"
              onclick="V.go('profile','${author.id || post.authorId}')">
              ${esc(author.name)}
            </span>
            <span class="post-handle">@${esc(author.handle || "")}</span>
            <span class="post-time">${timeAgo(post.createdAt)}</span>
          </div>
          ${badges[post.type] || ""}
          <div class="post-content">${formatContent(post.content)}</div>
          <div class="post-actions">
            <button class="btn-action ${isLiked ? "liked" : ""}"
              onclick="V.toggleLike('${post.id}', ${isLiked})">
              <svg viewBox="0 0 24 24" fill="${isLiked ? "currentColor" : "none"}"
                stroke="currentColor" stroke-width="2">
                <path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z"/>
              </svg>
              ${(post.likes || []).length}
            </button>
            <button class="btn-action" onclick="V.showComments('${post.id}')">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/>
              </svg>
              ${post.commentCount || 0}
            </button>
            ${
							canDelete
								? `
              <button class="btn-action" onclick="V.deletePost('${post.id}')"
                style="margin-left:auto;color:#f26b6b">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <polyline points="3 6 5 6 21 6"/>
                  <path d="M19 6l-1 14H6L5 6"/>
                  <path d="M10 11v6M14 11v6"/>
                </svg>
              </button>`
								: ""
						}
          </div>
        </div>
      </div>`;
	},

	async toggleLike(postId, isLiked) {
		const postRef = doc(db, "posts", postId);
		if (isLiked) {
			await updateDoc(postRef, { likes: arrayRemove(currentUser.id) });
		} else {
			await updateDoc(postRef, { likes: arrayUnion(currentUser.id) });
		}
	},

	async deletePost(postId) {
		if (!confirm("Supprimer cette publication ?")) return;
		await deleteDoc(doc(db, "posts", postId));
	},

	async showComments(postId) {
		const snap = await getDocs(
			query(
				collection(db, "posts", postId, "comments"),
				orderBy("createdAt", "asc"),
			),
		);
		const comments = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
		let html = "";
		for (const c of comments) {
			let user = { name: "?", avatarColor: "#888" };
			try {
				const u = await getDoc(doc(db, "users", c.authorId));
				if (u.exists()) user = u.data();
			} catch {}
			html += `
        <div style="display:flex;gap:10px;margin-bottom:12px">
          ${avatarHTML(user)}
          <div>
            <div style="font-size:13px;font-weight:500">${esc(user.name)}</div>
            <div style="font-size:14px;margin-top:2px">${formatContent(c.text)}</div>
          </div>
        </div>`;
		}
		this.showModal(`
      <div class="modal-title">Commentaires</div>
      ${html || '<p style="color:var(--text3);font-size:14px;margin-bottom:12px">Aucun commentaire.</p>'}
      <div style="display:flex;gap:8px;margin-top:8px">
        <input type="text" class="form-input" id="comment-input" placeholder="Votre commentaire...">
        <button class="btn-primary" onclick="V.addComment('${postId}')">Envoyer</button>
      </div>`);
	},

	async addComment(postId) {
		const text = $("comment-input")?.value?.trim();
		if (!text) return;
		await addDoc(collection(db, "posts", postId, "comments"), {
			authorId: currentUser.id,
			text,
			createdAt: serverTimestamp(),
		});
		await updateDoc(doc(db, "posts", postId), { commentCount: increment(1) });
		this.closeModal();
	},

	// ---- MESSAGES ----

	renderMessages(el) {
		el.innerHTML = `
      <div style="max-width:680px;margin:0 auto;padding:0 16px">
        <div class="page-header"><div class="page-title">Messages</div></div>
        <div id="conv-list">
          <div class="loading-screen" style="height:200px"><div class="spinner"></div></div>
        </div>
      </div>
      <button class="new-msg-btn" onclick="V.newMessage()">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
        </svg>
      </button>`;

		const q = query(
			collection(db, "conversations"),
			where("members", "array-contains", currentUser.id),
			orderBy("lastAt", "desc"),
		);
		const unsub = onSnapshot(q, async (snap) => {
			const list = $("conv-list");
			if (!list) return;
			const convs = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
			if (!convs.length) {
				list.innerHTML =
					'<div class="empty-state"><p>Aucune conversation.</p></div>';
				return;
			}
			list.innerHTML = "";
			for (const conv of convs) {
				const otherId = conv.members.find((m) => m !== currentUser.id);
				if (!otherId) continue;
				const userSnap = await getDoc(doc(db, "users", otherId));
				const other = userSnap.exists()
					? { id: otherId, ...userSnap.data() }
					: {
							id: otherId,
							name: "Utilisateur",
							handle: "user",
							avatarColor: "#888",
						};
				const hasUnread = (conv.unread || {})[currentUser.id] > 0;
				const div = document.createElement("div");
				div.innerHTML = `
          <div class="msg-item ${hasUnread ? "unread" : ""}"
            onclick="V.go('chat',{uid:'${otherId}',cid:'${conv.id}'})">
            ${avatarHTML(other)}
            <div class="msg-info">
              <div class="msg-name">${esc(other.name)}</div>
              <div class="msg-preview">${esc((conv.lastMsg || "").substring(0, 60))}</div>
            </div>
            <div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px">
              <div style="font-size:12px;color:var(--text3)">${timeAgo(conv.lastAt)}</div>
              ${hasUnread ? '<div class="msg-dot"></div>' : ""}
            </div>
          </div>`;
				list.appendChild(div.firstChild);
			}
		});
		listeners.push(unsub);
	},

	// ---- CHAT EN TEMPS RÉEL ----

	async renderChat(el, data) {
		if (!data) {
			this.go("messages");
			return;
		}
		const { uid, cid } = data;

		// Récupérer les infos de l'autre utilisateur
		const userSnap = await getDoc(doc(db, "users", uid));
		const other = userSnap.exists()
			? { id: uid, ...userSnap.data() }
			: { id: uid, name: "Utilisateur", handle: "user", avatarColor: "#888" };
		const online = await isOnline(uid);

		el.innerHTML = `
      <div class="chat-window">
        <div class="chat-header">
          <button class="btn-action" onclick="V.go('messages')">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" height="20">
              <polyline points="15 18 9 12 15 6"/>
            </svg>
          </button>
          ${avatarHTML(other)}
          <div>
            <div style="font-weight:500;font-size:15px">${esc(other.name)}</div>
            <div style="font-size:12px;color:var(--text3)" id="online-status">
              ${online ? '<span class="online-dot"></span> En ligne' : "@" + esc(other.handle || "")}
            </div>
          </div>
        </div>
        <div class="chat-messages" id="chat-messages"></div>
        <div class="typing-indicator" id="typing-indicator"></div>
        <div class="chat-input-area">
          <textarea class="chat-input" id="chat-input"
            placeholder="Votre message..."
            rows="1"
            onkeydown="V.chatKeydown(event,'${uid}','${cid || ""}')"
            oninput="V.sendTypingSignal('${cid || uid}')">
          </textarea>
          <button class="btn-send" onclick="V.sendMessage('${uid}','${cid || ""}')">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="22" y1="2" x2="11" y2="13"/>
              <polygon points="22 2 15 22 11 13 2 9 22 2"/>
            </svg>
          </button>
        </div>
      </div>`;

		// Trouver ou créer la conversation dans Firestore
		let convId = cid;
		if (!convId) {
			const existing = await getDocs(
				query(
					collection(db, "conversations"),
					where("members", "array-contains", currentUser.id),
				),
			);
			const found = existing.docs.find((d) =>
				(d.data().members || []).includes(uid),
			);
			if (found) {
				convId = found.id;
			} else {
				const newConv = await addDoc(collection(db, "conversations"), {
					members: [currentUser.id, uid],
					lastMsg: "",
					lastAt: serverTimestamp(),
					unread: { [uid]: 0, [currentUser.id]: 0 },
				});
				convId = newConv.id;
			}
		}

		// Marquer les messages comme lus
		try {
			await updateDoc(doc(db, "conversations", convId), {
				[`unread.${currentUser.id}`]: 0,
			});
		} catch {}

		// Écouter les nouveaux messages en temps réel (Realtime Database)
		const msgsRef = ref(rtdb, `msgs/${convId}`);
		chatUnsub = () => off(msgsRef);
		onChildAdded(msgsRef, (snap) => {
			const msg = snap.val();
			const isMe = msg.sid === currentUser.id;
			const container = $("chat-messages");
			if (!container) return;
			const div = document.createElement("div");
			div.innerHTML = `
        <div class="chat-msg ${isMe ? "me" : ""}">
          <div class="chat-bubble">${formatContent(msg.c)}</div>
        </div>`;
			container.appendChild(div.firstChild);
			container.scrollTop = container.scrollHeight;
		});

		// Écouter l'indicateur "en train d'écrire"
		const typingRef = ref(rtdb, `typing/${convId}/${uid}`);
		onValue(typingRef, (snap) => {
			const ti = $("typing-indicator");
			if (ti)
				ti.textContent =
					snap.val() === true ? `${other.name} est en train d'écrire...` : "";
		});

		// Écouter le statut en ligne en temps réel
		const presRef = ref(rtdb, `presence/${uid}`);
		onValue(presRef, (snap) => {
			const status = $("online-status");
			if (status) {
				const d = snap.val();
				status.innerHTML = d?.online
					? '<span class="online-dot"></span> En ligne'
					: "@" + esc(other.handle || "");
			}
		});
	},

	chatKeydown(e, uid, cid) {
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			this.sendMessage(uid, cid);
		}
	},

	async sendTypingSignal(convId) {
		if (!convId) return;
		const typRef = ref(rtdb, `typing/${convId}/${currentUser.id}`);
		await set(typRef, true);
		clearTimeout(typingTimeout);
		typingTimeout = setTimeout(() => set(typRef, false), 2000);
	},

	async sendMessage(uid, cid) {
		const input = $("chat-input");
		const text = input?.value?.trim();
		if (!text) return;

		// Trouver/créer la conversation
		let convId = cid;
		if (!convId) {
			const existing = await getDocs(
				query(
					collection(db, "conversations"),
					where("members", "array-contains", currentUser.id),
				),
			);
			const found = existing.docs.find((d) =>
				(d.data().members || []).includes(uid),
			);
			if (found) {
				convId = found.id;
			} else {
				const newConv = await addDoc(collection(db, "conversations"), {
					members: [currentUser.id, uid],
					lastMsg: "",
					lastAt: serverTimestamp(),
					unread: { [uid]: 0, [currentUser.id]: 0 },
				});
				convId = newConv.id;
			}
		}

		// Envoyer dans Realtime Database (instantané)
		await push(ref(rtdb, `msgs/${convId}`), {
			sid: currentUser.id,
			c: text,
			ts: Date.now(),
		});

		// Mettre à jour le dernier message dans Firestore
		await updateDoc(doc(db, "conversations", convId), {
			lastMsg: text,
			lastAt: serverTimestamp(),
			[`unread.${uid}`]: 999,
		});

		// Arrêter l'indicateur "en train d'écrire"
		await set(ref(rtdb, `typing/${convId}/${currentUser.id}`), false);
		input.value = "";
	},

	async newMessage() {
		const snap = await getDocs(collection(db, "users"));
		const users = snap.docs
			.filter((d) => d.id !== currentUser.id && !d.data().banned)
			.map((d) => ({ id: d.id, ...d.data() }));
		this.showModal(`
      <div class="modal-title">Nouveau message</div>
      ${
				users
					.map(
						(u) => `
        <div class="msg-item"
          onclick="V.closeModal();V.go('chat',{uid:'${u.id}',cid:''})">
          ${avatarHTML(u)}
          <div class="msg-info">
            <div class="msg-name">${esc(u.name)}</div>
            <div class="msg-preview">@${esc(u.handle)}</div>
          </div>
        </div>`,
					)
					.join("") || '<p style="color:var(--text3)">Aucun utilisateur.</p>'
			}`);
	},

	// ---- GROUPES ----

	async renderGroups(el) {
		el.innerHTML = `
      <div style="max-width:680px;margin:0 auto;padding:0 16px">
        <div class="page-header"><div class="page-title">Groupes</div></div>
        <div class="loading-screen" style="height:200px"><div class="spinner"></div></div>
      </div>`;

		const snap = await getDocs(collection(db, "groups"));
		const groups = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
		const mine = groups.filter((g) =>
			(g.members || []).includes(currentUser.id),
		);
		const others = groups.filter(
			(g) => !(g.members || []).includes(currentUser.id),
		);

		el.innerHTML = `
      <div style="max-width:680px;margin:0 auto;padding:0 16px 40px">
        <div class="page-header"><div class="page-title">Groupes</div></div>
        <button class="btn-primary" style="margin:16px 0;width:100%"
          onclick="V.showCreateGroupModal()">+ Créer un groupe</button>
        ${
					mine.length
						? `<div class="rp-title" style="margin-bottom:8px">Mes groupes</div>
             ${mine.map((g) => this.groupItemHTML(g, true)).join("")}`
						: ""
				}
        ${
					others.length
						? `<div class="rp-title" style="margin:16px 0 8px">Rejoindre un groupe</div>
             ${others.map((g) => this.groupItemHTML(g, false)).join("")}`
						: ""
				}
        ${!groups.length ? '<div class="empty-state"><p>Aucun groupe. Créez le premier !</p></div>' : ""}
      </div>`;
	},

	groupItemHTML(g, isMember) {
		return `
      <div class="group-item">
        <div class="group-icon">${g.emoji || "💬"}</div>
        <div style="flex:1">
          <div style="font-size:14px;font-weight:500">${esc(g.name)}</div>
          <div style="font-size:12px;color:var(--text3)">
            ${(g.members || []).length} membre${(g.members || []).length > 1 ? "s" : ""}
          </div>
        </div>
        ${
					isMember
						? `<button class="btn-secondary" style="font-size:12px;padding:6px 12px"
               onclick="V.go('chat',{uid:'__group__',cid:'${g.id}'})">Ouvrir</button>`
						: `<button class="btn-follow" onclick="V.joinGroup('${g.id}')">Rejoindre</button>`
				}
      </div>`;
	},

	async joinGroup(groupId) {
		await updateDoc(doc(db, "groups", groupId), {
			members: arrayUnion(currentUser.id),
		});
		this.go("groups");
	},

	showCreateGroupModal() {
		const emojis = ["🎨", "💻", "🎵", "🎮", "📚", "🏃", "🍕", "✈️", "💡", "🌿"];
		this.showModal(`
      <div class="modal-title">Créer un groupe</div>
      <div class="form-group">
        <label class="form-label">Nom du groupe</label>
        <input type="text" class="form-input" id="group-name" placeholder="Mon groupe"/>
      </div>
      <div class="form-group">
        <label class="form-label">Emoji</label>
        <div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:4px">
          ${emojis
						.map(
							(e) =>
								`<button onclick="V.selectEmoji(this,'${e}')"
              style="font-size:24px;background:var(--bg3);border:2px solid transparent;border-radius:8px;padding:6px;cursor:pointer">
              ${e}
            </button>`,
						)
						.join("")}
        </div>
        <input type="hidden" id="group-emoji" value="💬">
      </div>
      <div style="display:flex;gap:10px;margin-top:20px">
        <button class="btn-secondary" onclick="V.closeModal()">Annuler</button>
        <button class="btn-primary" onclick="V.createGroup()">Créer</button>
      </div>`);
	},

	selectEmoji(btn, emoji) {
		document
			.querySelectorAll('#modal-content button[style*="font-size:24px"]')
			.forEach((b) => (b.style.borderColor = "transparent"));
		btn.style.borderColor = "var(--accent)";
		$("group-emoji").value = emoji;
	},

	async createGroup() {
		const name = $("group-name")?.value?.trim();
		const emoji = $("group-emoji")?.value || "💬";
		if (!name) return;
		await addDoc(collection(db, "groups"), {
			name,
			emoji,
			members: [currentUser.id],
			createdBy: currentUser.id,
			createdAt: serverTimestamp(),
		});
		this.closeModal();
		this.go("groups");
	},

	// ---- RECHERCHE ----

	renderSearch(el) {
		searchTab = "users";
		el.innerHTML = `
      <div class="main-inner">
        <div class="page-header"><div class="page-title">Recherche</div></div>
        <div class="search-box" style="margin-top:16px">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
          </svg>
          <input type="text" id="search-input"
            placeholder="Rechercher des utilisateurs ou publications..."
            oninput="V.doSearch(this.value)"
            autofocus/>
        </div>
        <div class="tab-bar">
          <div class="tab active" id="tab-users" onclick="V.setSearchTab('users')">Personnes</div>
          <div class="tab"       id="tab-posts" onclick="V.setSearchTab('posts')">Publications</div>
        </div>
        <div id="search-results" style="padding-top:8px"></div>
      </div>`;
	},

	setSearchTab(tab) {
		searchTab = tab;
		document
			.querySelectorAll(".tab")
			.forEach((t) => t.classList.remove("active"));
		$("tab-" + tab)?.classList.add("active");
		this.doSearch($("search-input")?.value || "");
	},

	async doSearch(q) {
		const results = $("search-results");
		if (!results) return;
		if (!q.trim()) {
			results.innerHTML = "";
			return;
		}
		results.innerHTML =
			'<div class="loading-screen" style="height:100px"><div class="spinner"></div></div>';

		if (searchTab === "users") {
			const snap = await getDocs(collection(db, "users"));
			const users = snap.docs
				.filter((d) => d.id !== currentUser.id && !d.data().banned)
				.map((d) => ({ id: d.id, ...d.data() }))
				.filter(
					(u) =>
						u.name?.toLowerCase().includes(q.toLowerCase()) ||
						u.handle?.toLowerCase().includes(q.toLowerCase()),
				);
			results.innerHTML =
				users
					.map(
						(u) => `
        <div class="user-card" onclick="V.go('profile','${u.id}')">
          ${avatarHTML(u)}
          <div class="user-card-info">
            <div class="user-card-name">${esc(u.name)}</div>
            <div class="user-card-bio">
              @${esc(u.handle)}${u.bio ? " · " + esc(u.bio.substring(0, 40)) : ""}
            </div>
          </div>
          <button class="btn-follow ${(currentUser.following || []).includes(u.id) ? "following" : ""}"
            onclick="event.stopPropagation();V.toggleFollow('${u.id}',this)">
            ${(currentUser.following || []).includes(u.id) ? "Suivi" : "Suivre"}
          </button>
        </div>`,
					)
					.join("") ||
				'<div class="empty-state"><p>Aucun utilisateur trouvé.</p></div>';
		} else {
			const snap = await getDocs(
				query(
					collection(db, "posts"),
					where("type", "==", "public"),
					orderBy("createdAt", "desc"),
					limit(30),
				),
			);
			const posts = snap.docs
				.map((d) => ({ id: d.id, ...d.data() }))
				.filter((p) => p.content?.toLowerCase().includes(q.toLowerCase()));
			results.innerHTML = "";
			for (const p of posts) {
				const div = document.createElement("div");
				div.innerHTML = await this.postHTML(p);
				results.appendChild(div.firstChild);
			}
			if (!posts.length)
				results.innerHTML =
					'<div class="empty-state"><p>Aucune publication trouvée.</p></div>';
		}
	},

	async toggleFollow(uid, btn) {
		const meRef = doc(db, "users", currentUser.id);
		const themRef = doc(db, "users", uid);
		const isFollowing = (currentUser.following || []).includes(uid);
		if (isFollowing) {
			await updateDoc(meRef, { following: arrayRemove(uid) });
			await updateDoc(themRef, { followers: arrayRemove(currentUser.id) });
			currentUser.following = (currentUser.following || []).filter(
				(x) => x !== uid,
			);
			if (btn) {
				btn.textContent = "Suivre";
				btn.classList.remove("following");
			}
		} else {
			await updateDoc(meRef, { following: arrayUnion(uid) });
			await updateDoc(themRef, { followers: arrayUnion(currentUser.id) });
			if (!currentUser.following) currentUser.following = [];
			currentUser.following.push(uid);
			if (btn) {
				btn.textContent = "Suivi";
				btn.classList.add("following");
			}
			// Notification
			await addDoc(collection(db, "notifications"), {
				toUid: uid,
				fromUid: currentUser.id,
				fromName: currentUser.name,
				type: "follow",
				read: false,
				createdAt: serverTimestamp(),
			});
		}
	},

	// ---- NOTIFICATIONS ----

	async renderNotifications(el) {
		el.innerHTML = `
      <div style="max-width:680px;margin:0 auto;padding:0 16px">
        <div class="page-header"><div class="page-title">Notifications</div></div>
        <div class="loading-screen" style="height:200px"><div class="spinner"></div></div>
      </div>`;

		const snap = await getDocs(
			query(
				collection(db, "notifications"),
				where("toUid", "==", currentUser.id),
				orderBy("createdAt", "desc"),
				limit(30),
			),
		);
		const notifs = snap.docs.map((d) => ({ id: d.id, ...d.data() }));

		const icons = {
			like: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z"/></svg>`,
			follow: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>`,
			comment: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>`,
		};
		const labels = {
			like: "a aimé votre publication",
			follow: "vous suit maintenant",
			comment: "a commenté votre publication",
		};

		el.innerHTML = `
      <div style="max-width:680px;margin:0 auto;padding:0 16px">
        <div class="page-header"><div class="page-title">Notifications</div></div>
        <div>
          ${
						notifs.length
							? notifs
									.map(
										(n) => `
                <div class="notif-item">
                  <div class="notif-icon ${n.type}">${icons[n.type] || ""}</div>
                  <div>
                    <div class="notif-text">
                      <span>${esc(n.fromName || "Quelqu'un")}</span>
                      ${labels[n.type] || n.type}
                    </div>
                    <div class="notif-time">${timeAgo(n.createdAt)}</div>
                  </div>
                </div>`,
									)
									.join("")
							: '<div class="empty-state"><p>Aucune notification.</p></div>'
					}
        </div>
      </div>`;

		// Marquer toutes comme lues
		snap.docs.forEach((d) => {
			if (!d.data().read)
				updateDoc(doc(db, "notifications", d.id), { read: true });
		});
	},

	// ---- PROFIL ----

	async renderProfile(el, uid) {
		el.innerHTML = `
      <div class="main-inner">
        <div class="loading-screen" style="height:200px"><div class="spinner"></div></div>
      </div>`;

		const snap = await getDoc(doc(db, "users", uid));
		if (!snap.exists()) {
			el.innerHTML =
				'<div class="empty-state"><p>Utilisateur introuvable.</p></div>';
			return;
		}
		const user = { id: uid, ...snap.data() };
		const isMe = uid === currentUser.id;
		const isFollowing = !isMe && (currentUser.following || []).includes(uid);

		const postsSnap = await getDocs(
			query(
				collection(db, "posts"),
				where("authorId", "==", uid),
				orderBy("createdAt", "desc"),
				limit(20),
			),
		);
		const posts = postsSnap.docs
			.map((d) => ({ id: d.id, ...d.data() }))
			.filter((p) => p.type === "public" || isMe);

		el.innerHTML = `
      <div class="main-inner">
        <div class="page-header">
          <div class="page-title">${isMe ? "Mon profil" : esc(user.name)}</div>
        </div>
        <div class="profile-header">
          ${avatarHTML(user, "avatar-xl")}
          <div style="margin-top:12px">
            <div style="font-family:var(--font-display);font-size:22px;font-weight:700">
              ${esc(user.name)}
            </div>
            <div style="color:var(--text3);font-size:14px;margin-top:2px">
              @${esc(user.handle || "")}
            </div>
          </div>
          ${user.bio ? `<div style="font-size:14px;color:var(--text2);margin:10px 0">${esc(user.bio)}</div>` : ""}
          <div class="profile-stats">
            <div class="stat">
              <div class="stat-val">${posts.length}</div>
              <div class="stat-lbl">Publications</div>
            </div>
            <div class="stat">
              <div class="stat-val">${(user.followers || []).length}</div>
              <div class="stat-lbl">Abonnés</div>
            </div>
            <div class="stat">
              <div class="stat-val">${(user.following || []).length}</div>
              <div class="stat-lbl">Abonnements</div>
            </div>
          </div>
          ${
						isMe
							? `<button class="btn-secondary" style="margin-top:16px"
                onclick="V.go('settings')">Modifier le profil</button>`
							: `<div style="display:flex;gap:10px;justify-content:center;margin-top:16px">
                <button class="btn-follow ${isFollowing ? "following" : ""}"
                  onclick="V.toggleFollow('${uid}',this)">
                  ${isFollowing ? "Suivi" : "Suivre"}
                </button>
                <button class="btn-secondary"
                  onclick="V.go('chat',{uid:'${uid}',cid:''})">Message</button>
               </div>`
					}
        </div>
        <div id="profile-posts">
          <div class="loading-screen" style="height:100px"><div class="spinner"></div></div>
        </div>
      </div>`;

		const postsContainer = $("profile-posts");
		if (!posts.length) {
			postsContainer.innerHTML =
				'<div class="empty-state"><p>Aucune publication publique.</p></div>';
			return;
		}
		postsContainer.innerHTML = "";
		for (const p of posts) {
			const div = document.createElement("div");
			div.innerHTML = await this.postHTML(p);
			postsContainer.appendChild(div.firstChild);
		}
	},

	// ---- PARAMÈTRES ----

	renderSettings(el) {
		const themes = [
			{ id: "dark", label: "Nuit", c1: "#141417", c2: "#7c6af7" },
			{ id: "light", label: "Jour", c1: "#f4f3f9", c2: "#6452e9" },
			{ id: "rose", label: "Rose", c1: "#17111a", c2: "#d46ef5" },
			{ id: "ocean", label: "Océan", c1: "#0b1525", c2: "#4a9eff" },
			{ id: "forest", label: "Forêt", c1: "#0e1a10", c2: "#4ecb7a" },
		];
		const currentTheme =
			document.documentElement.getAttribute("data-theme") || "dark";

		el.innerHTML = `
      <div style="max-width:680px;margin:0 auto;padding:0 16px 40px">
        <div class="page-header"><div class="page-title">Paramètres</div></div>

        <div class="settings-section">
          <h3>Apparence</h3>
          <div class="form-label" style="margin-bottom:10px">Thème</div>
          <div class="theme-grid">
            ${themes
							.map(
								(t) => `
              <div style="text-align:center">
                <button class="theme-btn ${currentTheme === t.id ? "active" : ""}"
                  onclick="V.setTheme('${t.id}')"
                  style="background:linear-gradient(135deg,${t.c1} 50%,${t.c2} 150%)"
                  title="${t.label}">
                  ${
										currentTheme === t.id
											? `<svg style="width:16px;height:16px;color:#fff" viewBox="0 0 24 24"
                         fill="none" stroke="currentColor" stroke-width="3">
                         <polyline points="20 6 9 17 4 12"/>
                       </svg>`
											: ""
									}
                </button>
                <div style="font-size:11px;color:var(--text3);margin-top:4px">${t.label}</div>
              </div>`,
							)
							.join("")}
          </div>
        </div>

        <div class="settings-section">
          <h3>Informations du profil</h3>
          <div class="form-group">
            <label class="form-label">Nom d'affichage</label>
            <input type="text" class="form-input" id="s-name" value="${esc(currentUser.name || "")}"/>
          </div>
          <div class="form-group">
            <label class="form-label">Pseudo</label>
            <input type="text" class="form-input" id="s-handle" value="${esc(currentUser.handle || "")}"/>
          </div>
          <div class="form-group">
            <label class="form-label">Bio</label>
            <textarea class="form-input form-textarea" id="s-bio">${esc(currentUser.bio || "")}</textarea>
          </div>
          <div class="form-group">
            <label class="form-label">URL photo de profil</label>
            <input type="text" class="form-input" id="s-avatar"
              value="${esc(currentUser.avatar || "")}" placeholder="https://..."/>
          </div>
          <div class="form-group">
            <label class="form-label">Couleur de l'avatar</label>
            <input type="color" id="s-color"
              value="${currentUser.avatarColor || "#7c6af7"}"
              style="width:48px;height:36px;border-radius:8px;border:1px solid var(--border);cursor:pointer;background:transparent"/>
          </div>
          <button class="btn-primary" onclick="V.saveProfile()">Enregistrer</button>
          <div id="settings-message" style="margin-top:10px"></div>
        </div>

        <div class="settings-section" style="border-color:rgba(242,107,107,0.3)">
          <h3 style="color:var(--danger)">Zone dangereuse</h3>
          <p style="font-size:14px;color:var(--text2);margin-bottom:16px">
            Cette action est irréversible.
          </p>
          <button class="btn-danger"
            onclick="if(confirm('Supprimer votre compte définitivement ?'))V.deleteAccount()">
            Supprimer mon compte
          </button>
        </div>
      </div>`;
	},

	setTheme(theme) {
		document.documentElement.setAttribute("data-theme", theme);
		localStorage.setItem("aevox_theme", theme);
		this.go("settings");
	},

	async saveProfile() {
		const name = $("s-name")?.value?.trim();
		const handle = $("s-handle")
			?.value?.trim()
			?.replace(/[^a-z0-9_]/gi, "");
		const bio = $("s-bio")?.value?.trim();
		const avatar = $("s-avatar")?.value?.trim();
		const color = $("s-color")?.value;

		if (!name || !handle) {
			$("settings-message").innerHTML =
				'<div class="alert alert-error">Nom et pseudo sont requis.</div>';
			return;
		}

		const updates = {
			name,
			handle,
			bio,
			avatarColor: color,
			avatar: avatar || null,
		};
		await updateDoc(doc(db, "users", currentUser.id), updates);
		Object.assign(currentUser, updates);
		this.updateSidebar();
		$("settings-message").innerHTML =
			'<div class="alert alert-success">Profil mis à jour !</div>';
	},

	async deleteAccount() {
		await deleteDoc(doc(db, "users", currentUser.id));
		await this.logout();
	},

	// ---- ADMINISTRATION ----

	async renderAdmin(el) {
		if (currentUser.role !== "admin") {
			this.go("home");
			return;
		}

		el.innerHTML = `
      <div style="max-width:800px;margin:0 auto;padding:0 16px">
        <div class="page-header">
          <div class="page-title">Administration</div>
          <div class="page-subtitle">Gestion de Aevox</div>
        </div>
        <div class="loading-screen" style="height:200px"><div class="spinner"></div></div>
      </div>`;

		const [usersSnap, postsSnap] = await Promise.all([
			getDocs(collection(db, "users")),
			getDocs(collection(db, "posts")),
		]);
		const users = usersSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
		const posts = postsSnap.docs.map((d) => ({ id: d.id, ...d.data() }));

		const rows = users
			.map(
				(u) => `
      <tr>
        <td>
          <div style="display:flex;align-items:center;gap:8px">
            ${avatarHTML(u)}
            <div>
              <div style="font-weight:500;font-size:13px">${esc(u.name)}</div>
              <div style="font-size:12px;color:var(--text3)">@${esc(u.handle || "")}</div>
            </div>
          </div>
        </td>
        <td>
          <span class="badge badge-${u.role === "admin" ? "admin" : "user"}">
            ${u.role === "admin" ? "Admin" : "Utilisateur"}
          </span>
        </td>
        <td style="font-size:13px;color:var(--text3)">${esc(u.email || "")}</td>
        <td>
          ${
						u.id !== currentUser.id
							? `<div style="display:flex;gap:8px;align-items:center">
                <button class="toggle ${u.role === "admin" ? "on" : ""}"
                  onclick="V.toggleAdminRole('${u.id}','${u.role}')"
                  title="Rôle admin"></button>
                <button class="toggle ${u.banned ? "on" : ""}"
                  onclick="V.toggleBan('${u.id}',${!!u.banned})"
                  style="${u.banned ? "background:#f26b6b" : ""}"
                  title="Bannir"></button>
                <span style="font-size:11px;color:#f26b6b">${u.banned ? "Banni" : ""}</span>
               </div>`
							: '<span style="font-size:12px;color:var(--text3)">Vous</span>'
					}
        </td>
      </tr>`,
			)
			.join("");

		el.innerHTML = `
      <div style="max-width:800px;margin:0 auto;padding:0 16px 40px">
        <div class="page-header">
          <div class="page-title">Administration</div>
          <div class="page-subtitle">Gestion de Aevox</div>
        </div>
        <div class="admin-stat-grid" style="margin-top:16px">
          <div class="admin-stat">
            <div class="admin-stat-val">${users.length}</div>
            <div class="admin-stat-lbl">Utilisateurs</div>
          </div>
          <div class="admin-stat">
            <div class="admin-stat-val">${posts.length}</div>
            <div class="admin-stat-lbl">Publications</div>
          </div>
          <div class="admin-stat">
            <div class="admin-stat-val">${users.filter((u) => u.role === "admin").length}</div>
            <div class="admin-stat-lbl">Admins</div>
          </div>
        </div>
        <div class="settings-section" style="overflow-x:auto">
          <h3>Gestion des utilisateurs</h3>
          <table class="admin-table">
            <thead>
              <tr>
                <th>Utilisateur</th>
                <th>Rôle</th>
                <th>Email</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
        <div class="settings-section">
          <h3>Publications récentes</h3>
          <div id="admin-posts">
            <div class="loading-screen" style="height:100px"><div class="spinner"></div></div>
          </div>
        </div>
      </div>`;

		const postsContainer = $("admin-posts");
		postsContainer.innerHTML = "";
		for (const p of posts.slice(0, 5)) {
			const div = document.createElement("div");
			div.innerHTML = await this.postHTML(p);
			postsContainer.appendChild(div.firstChild);
		}
	},

	async toggleAdminRole(uid, currentRole) {
		await updateDoc(doc(db, "users", uid), {
			role: currentRole === "admin" ? "user" : "admin",
		});
		this.go("admin");
	},

	async toggleBan(uid, isBanned) {
		await updateDoc(doc(db, "users", uid), { banned: !isBanned });
		this.go("admin");
	},

	// ---- PANNEAU DROIT ----

	async loadRightPanel() {
		// Tendances
		const trends = [
			"#aevox",
			"#design",
			"#technologie",
			"#france",
			"#coding",
			"#ia",
		];
		const trendsEl = $("trends-panel");
		if (trendsEl) {
			trendsEl.innerHTML = trends
				.slice(0, 5)
				.map(
					(tag, i) => `
        <div class="trend-item">
          <div class="trend-category">${["Tech", "Design", "Société", "Culture", "Dev"][i]}</div>
          <div class="trend-tag">${tag}</div>
          <div class="trend-count">${((Math.random() * 10000 + 500) | 0).toLocaleString()} aevox</div>
        </div>`,
				)
				.join("");
		}

		// Suggestions
		try {
			const snap = await getDocs(collection(db, "users"));
			const users = snap.docs
				.filter((d) => d.id !== currentUser.id && !d.data().banned)
				.slice(0, 3)
				.map((d) => ({ id: d.id, ...d.data() }));
			const suggsEl = $("suggestions-panel");
			if (suggsEl) {
				suggsEl.innerHTML =
					users
						.map(
							(u) => `
          <div style="display:flex;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid var(--border)">
            ${avatarHTML(u)}
            <div style="flex:1;cursor:pointer" onclick="V.go('profile','${u.id}')">
              <div style="font-size:13px;font-weight:500">${esc(u.name)}</div>
              <div style="font-size:12px;color:var(--text3)">@${esc(u.handle || "")}</div>
            </div>
            <button class="btn-follow ${(currentUser.following || []).includes(u.id) ? "following" : ""}"
              onclick="V.toggleFollow('${u.id}',this)">
              ${(currentUser.following || []).includes(u.id) ? "Suivi" : "Suivre"}
            </button>
          </div>`,
						)
						.join("") ||
					'<p style="font-size:13px;color:var(--text3)">Aucune suggestion.</p>';
			}
		} catch {}
	},

	// ---- MODAL ----

	showModal(html) {
		$("modal-content").innerHTML = html;
		$("modal-overlay").style.display = "flex";
	},

	closeModal(e) {
		if (!e || e.target === $("modal-overlay")) {
			$("modal-overlay").style.display = "none";
		}
	},
});

// ================================================
//  INITIALISATION
// ================================================

// Appliquer le thème sauvegardé
const savedTheme = localStorage.getItem("aevox_theme");
if (savedTheme) document.documentElement.setAttribute("data-theme", savedTheme);

// Démarrer Google Sign-In
initGoogleSignIn();
