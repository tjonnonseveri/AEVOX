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
		V.showMobileNav();
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
		if (presenceRef) set(presenceRef, { online: false, lastSeen: rts() });
		listeners.forEach((u) => u());
		listeners = [];
		if (chatUnsub) {
			chatUnsub();
			chatUnsub = null;
		}
		currentUser = null;
		await signOut(auth);
	},

	// Menu compte (déconnexion + changer de compte)
	showAccountMenu() {
		this.showModal(`
      <div class="modal-title" style="margin-bottom:16px">Mon compte</div>

      <!-- Profil actuel -->
      <div style="display:flex;align-items:center;gap:12px;padding:14px;background:var(--bg3);border-radius:var(--radius-sm);margin-bottom:16px">
        ${avatarHTML(currentUser, "avatar-lg")}
        <div>
          <div style="font-weight:600;font-size:15px">${esc(currentUser.name)}</div>
          <div style="font-size:13px;color:var(--text3)">@${esc(currentUser.handle)}</div>
          <div style="font-size:12px;color:var(--text3);margin-top:2px">${esc(currentUser.email)}</div>
        </div>
      </div>

      <!-- Actions -->
      <div style="display:flex;flex-direction:column;gap:8px">
        <button class="btn-secondary" style="width:100%;text-align:left;display:flex;align-items:center;gap:10px"
          onclick="V.closeModal();V.go('profile')">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/>
          </svg>
          Voir mon profil
        </button>
        <button class="btn-secondary" style="width:100%;text-align:left;display:flex;align-items:center;gap:10px"
          onclick="V.closeModal();V.go('settings')">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="3"/>
            <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/>
          </svg>
          Param\u00e8tres
        </button>

        <hr style="border:none;border-top:1px solid var(--border);margin:4px 0">

        <button class="btn-secondary" style="width:100%;text-align:left;display:flex;align-items:center;gap:10px"
          onclick="V.switchAccount()">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/>
            <circle cx="9" cy="7" r="4"/>
            <path d="M23 21v-2a4 4 0 00-3-3.87"/>
            <path d="M16 3.13a4 4 0 010 7.75"/>
          </svg>
          Changer de compte
        </button>

        <button onclick="V.closeModal();V.confirmLogout()"
          style="width:100%;text-align:left;display:flex;align-items:center;gap:10px;background:rgba(242,107,107,0.08);border:1px solid rgba(242,107,107,0.2);color:#f26b6b;padding:10px 18px;border-radius:var(--radius-sm);font-family:var(--font);font-size:14px;font-weight:500;cursor:pointer">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/>
            <polyline points="16 17 21 12 16 7"/>
            <line x1="21" y1="12" x2="9" y2="12"/>
          </svg>
          Se d\u00e9connecter
        </button>
      </div>`);
	},

	confirmLogout() {
		this.showModal(`
      <div class="modal-title">Se d\u00e9connecter ?</div>
      <p style="font-size:14px;color:var(--text2);margin-bottom:20px">
        Vous serez redirig\u00e9 vers l'\u00e9cran de connexion.
      </p>
      <div class="btn-row">
        <button class="btn-secondary" onclick="V.closeModal()">Annuler</button>
        <button onclick="V.closeModal();V.logout()"
          style="background:rgba(242,107,107,0.15);border:1px solid rgba(242,107,107,0.3);color:#f26b6b;padding:10px 18px;border-radius:var(--radius-sm);font-family:var(--font);font-size:14px;font-weight:500;cursor:pointer">
          D\u00e9connecter
        </button>
      </div>`);
	},

	// Changer de compte : déconnecte et montre l'écran de connexion
	async switchAccount() {
		this.closeModal();
		this.showModal(`
      <div class="modal-title">Changer de compte</div>
      <p style="font-size:14px;color:var(--text2);margin-bottom:20px">
        Vous allez \u00eatre d\u00e9connect\u00e9 du compte <strong>${esc(currentUser.name)}</strong>.
        Vous pourrez ensuite vous connecter avec un autre compte.
      </p>
      <div class="btn-row">
        <button class="btn-secondary" onclick="V.closeModal()">Annuler</button>
        <button class="btn-primary" onclick="V.closeModal();V.logout()">Changer de compte</button>
      </div>`);
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

	// ---- NAV MOBILE ----

	setMobileNav(page) {
		document
			.querySelectorAll(".mobile-nav-item")
			.forEach((el) => el.classList.remove("active"));
		const active = $("mnav-" + page);
		if (active) active.classList.add("active");
	},

	showMobileNav() {
		const nav = $("mobile-nav");
		if (nav && window.innerWidth <= 480) nav.style.display = "flex";
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

		// Mettre à jour la navigation active (sidebar)
		document
			.querySelectorAll(".nav-item")
			.forEach((n) => n.classList.remove("active"));
		const navEl = $("nav-" + page);
		if (navEl) navEl.classList.add("active");

		// Mettre à jour la navigation mobile
		this.setMobileNav(page);

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
        <div id="announcements-banner"></div>
        ${this.composeHTML()}
        <div id="feed-container">
          <div class="loading-screen" style="height:200px"><div class="spinner"></div></div>
        </div>
      </div>`;

		// Charger les annonces
		getDocs(
			query(
				collection(db, "announcements"),
				orderBy("createdAt", "desc"),
				limit(3),
			),
		)
			.then((snap) => {
				const banner = $("announcements-banner");
				if (!banner || snap.empty) return;
				const colors = {
					info: "#4a9eff",
					success: "#5dd89e",
					warn: "#f5a623",
					danger: "#f26b6b",
				};
				const icons = { info: "ℹ️", success: "✅", warn: "⚠️", danger: "🚫" };
				banner.innerHTML = snap.docs
					.map((d) => {
						const a = d.data();
						const c = colors[a.type] || "#4a9eff";
						return `
          <div style="background:${c}11;border:1px solid ${c}44;border-radius:var(--radius-sm);padding:12px 16px;margin-top:12px;display:flex;gap:10px;align-items:flex-start">
            <div style="font-size:18px">${icons[a.type] || "📢"}</div>
            <div style="flex:1">
              <div style="font-weight:600;font-size:14px;color:${c}">${esc(a.title)}</div>
              <div style="font-size:13px;color:var(--text2);margin-top:4px">${esc(a.body)}</div>
              <div style="font-size:11px;color:var(--text3);margin-top:4px">Par l'équipe AEVOX &bull; ${timeAgo(a.createdAt)}</div>
            </div>
          </div>`;
					})
					.join("");
			})
			.catch(() => {});

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
			if (!posts.length) {
				feed.innerHTML =
					'<div class="empty-state"><p>Aucune publication. Soyez le premier !</p></div>';
				return;
			}
			feed.innerHTML =
				'<div class="loading-screen" style="height:100px"><div class="spinner"></div></div>';
			const htmlParts = await Promise.all(posts.map((p) => this.postHTML(p)));
			if (!$("feed-container")) return;
			feed.innerHTML =
				htmlParts.filter(Boolean).join("") ||
				'<div class="empty-state"><p>Aucune publication.</p></div>';
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

		// Pas de filtre where() pour éviter les index Firestore
		// On récupère tout et on filtre côté client
		const q = query(
			collection(db, "posts"),
			orderBy("createdAt", "desc"),
			limit(100),
		);
		const unsub = onSnapshot(q, async (snap) => {
			const feed = $("feed-container");
			if (!feed) return;
			const posts = snap.docs
				.map((d) => ({ id: d.id, ...d.data() }))
				.filter((p) => p.type === "public");
			if (!posts.length) {
				feed.innerHTML =
					'<div class="empty-state"><p>Aucune publication publique.</p></div>';
				return;
			}
			feed.innerHTML =
				'<div class="loading-screen" style="height:100px"><div class="spinner"></div></div>';
			const htmlParts = await Promise.all(posts.map((p) => this.postHTML(p)));
			if (!$("feed-container")) return;
			feed.innerHTML = htmlParts.filter(Boolean).join("");
		});
		listeners.push(unsub);
	},

	// ---- COMPOSEUR DE POST ----

	composeHTML() {
		return `
      <div class="compose-box" style="margin-top:16px">
        ${avatarHTML(currentUser)}
        <div class="compose-inner">
          <textarea id="compose-text" placeholder="Exprime-toi sur Aevox..." maxlength="280" oninput="V.updateCharCount(this)"></textarea>
          <div class="compose-footer">
            <select class="compose-select" id="compose-type">
              <option value="public">&#127757; Public</option>
              <option value="followers">&#128101; Abonnés</option>
            </select>
            <div style="display:flex;align-items:center;gap:10px">
              <span class="char-count" id="char-count">280</span>
              <button class="btn-primary" style="padding:8px 18px;font-size:13px" onclick="V.submitPost()">Publier</button>
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
		const ta = $("compose-text");
		if (!ta) return;
		const text = ta.value.trim();
		if (!text || text.length > 280) {
			if (!text) {
				ta.focus();
				return;
			}
			return;
		}
		const type = $("compose-type")?.value || "public";
		const btn = document.querySelector(".compose-box .btn-primary");
		if (btn) {
			btn.textContent = "...";
			btn.disabled = true;
		}
		try {
			await addDoc(collection(db, "posts"), {
				authorId: currentUser.id,
				content: text,
				type,
				likes: [],
				commentCount: 0,
				createdAt: serverTimestamp(),
			});
			ta.value = "";
			if ($("char-count")) $("char-count").textContent = "280";
		} catch (e) {
			console.error("Erreur publication:", e);
			alert("Erreur lors de la publication. Vérifiez votre connexion.");
		}
		if (btn) {
			btn.textContent = "Publier";
			btn.disabled = false;
		}
	},

	// ---- HTML D'UN POST ----

	async postHTML(post) {
		if (!post || !post.id) return "";
		// Récupérer les infos de l'auteur
		let author = null;
		if (post.authorId === currentUser?.id) {
			author = currentUser;
		} else if (post.authorId) {
			try {
				const snap = await getDoc(doc(db, "users", post.authorId));
				author = snap.exists()
					? { id: snap.id, ...snap.data() }
					: {
							name: post.authorName || "Utilisateur",
							handle: post.authorHandle || "user",
							avatarColor: "#888",
						};
			} catch {
				author = {
					name: post.authorName || "Utilisateur",
					handle: post.authorHandle || "user",
					avatarColor: "#888",
				};
			}
		} else {
			author = { name: "Utilisateur", handle: "user", avatarColor: "#888" };
		}

		const isLiked = (post.likes || []).includes(currentUser.id);
		const canDelete =
			post.authorId === currentUser.id || currentUser.role === "admin";
		const badges = {
			public: '<span class="post-badge badge-public">&#127757; Public</span>',
			followers:
				'<span class="post-badge badge-followers">&#128101; Abonnés</span>',
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
			orderBy("lastAt", "desc"),
			limit(100),
		);
		const unsub = onSnapshot(q, async (snap) => {
			const list = $("conv-list");
			if (!list) return;
			const convs = snap.docs
				.map((d) => ({ id: d.id, ...d.data() }))
				.filter((c) => (c.members || []).includes(currentUser.id));
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
		const isGroup = uid === "__group__" || !!data.groupId;
		const groupId = data.groupId || (isGroup ? cid : null);

		// ---- CAS GROUPE ----
		if (isGroup && groupId) {
			const groupSnap = await getDoc(doc(db, "groups", groupId));
			if (!groupSnap.exists()) {
				this.go("groups");
				return;
			}
			const group = { id: groupId, ...groupSnap.data() };

			el.innerHTML = `
        <div class="chat-window">
          <div class="chat-header">
            <button class="btn-action" onclick="V.go('groups')">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" height="20">
                <polyline points="15 18 9 12 15 6"/>
              </svg>
            </button>
            <div style="width:36px;height:36px;border-radius:12px;background:var(--accent-bg2);display:flex;align-items:center;justify-content:center;font-size:20px">${group.emoji || String.fromCodePoint(0x1f4ac)}</div>
            <div>
              <div style="font-weight:500;font-size:15px">${esc(group.name)}</div>
              <div style="font-size:12px;color:var(--text3)">${(group.members || []).length} membre(s)</div>
            </div>
            <button class="btn-secondary" style="margin-left:auto;font-size:12px;padding:6px 10px" onclick="V.manageGroup('${groupId}')">&#9881; Gérer</button>
          </div>
          <div class="chat-messages" id="chat-messages">
            <div class="empty-state" style="padding:24px"><p>Début de la discussion du groupe</p></div>
          </div>
          <div class="typing-indicator" id="typing-indicator"></div>
          <div class="chat-input-area">
            <textarea class="chat-input" id="chat-input"
              placeholder="Message dans ${esc(group.name)}..."
              rows="1"
              onkeydown="V.chatKeydown(event,'__group__','${groupId}')">
            </textarea>
            <button class="btn-send" onclick="V.sendGroupMessage('${groupId}')">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <line x1="22" y1="2" x2="11" y2="13"/>
                <polygon points="22 2 15 22 11 13 2 9 22 2"/>
              </svg>
            </button>
          </div>
        </div>`;

			// Écouter les messages du groupe (Realtime Database)
			const msgsRef = ref(rtdb, `group_msgs/${groupId}`);
			chatUnsub = () => off(msgsRef);
			// Charger les messages existants
			onChildAdded(msgsRef, async (snap) => {
				const msg = snap.val();
				const isMe = msg.sid === currentUser.id;
				const container = $("chat-messages");
				if (!container) return;
				// Vider l'état vide si c'est le premier message
				const emptyState = container.querySelector(".empty-state");
				if (emptyState) emptyState.remove();
				// Récupérer le nom de l'expéditeur
				let senderName = "Utilisateur";
				let senderColor = "#7c6af7";
				if (msg.sid === currentUser.id) {
					senderName = currentUser.name;
					senderColor = currentUser.avatarColor;
				} else {
					try {
						const uSnap = await getDoc(doc(db, "users", msg.sid));
						if (uSnap.exists()) {
							senderName = uSnap.data().name;
							senderColor = uSnap.data().avatarColor;
						}
					} catch {}
				}
				const div = document.createElement("div");
				div.innerHTML = `
          <div class="chat-msg ${isMe ? "me" : ""}">
            ${!isMe ? `<div class="avatar" style="background:${senderColor};width:28px;height:28px;font-size:11px;flex-shrink:0">${senderName[0]}</div>` : ""}
            <div>
              ${!isMe ? `<div style="font-size:11px;color:var(--text3);margin-bottom:3px">${esc(senderName)}</div>` : ""}
              <div class="chat-bubble">${formatContent(msg.c)}</div>
            </div>
          </div>`;
				container.appendChild(div.firstChild);
				container.scrollTop = container.scrollHeight;
			});
			return;
		}

		// ---- CAS MESSAGE DIRECT ----
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

		// Écouter les messages (Realtime Database)
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

		// Indicateur "en train d'écrire"
		const typingRef = ref(rtdb, `typing/${convId}/${uid}`);
		onValue(typingRef, (snap) => {
			const ti = $("typing-indicator");
			if (ti)
				ti.textContent =
					snap.val() === true ? `${other.name} est en train d'écrire...` : "";
		});

		// Statut en ligne
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

	async sendGroupMessage(groupId) {
		const input = $("chat-input");
		const text = input?.value?.trim();
		if (!text) return;
		input.value = "";
		await push(ref(rtdb, `group_msgs/${groupId}`), {
			sid: currentUser.id,
			c: text,
			ts: Date.now(),
		});
	},

	chatKeydown(e, uid, cid) {
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			if (uid === "__group__") {
				this.sendGroupMessage(cid);
			} else {
				this.sendMessage(uid, cid);
			}
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
        <button class="btn-primary" style="margin:16px 0;width:100%" onclick="V.showCreateGroupModal()">+ Créer un groupe</button>
        ${mine.length ? `<div class="rp-title" style="margin-bottom:8px">Mes groupes</div>${mine.map((g) => this.groupItemHTML(g, true)).join("")}` : ""}
        ${others.length ? `<div class="rp-title" style="margin:16px 0 8px">Rejoindre un groupe</div>${others.map((g) => this.groupItemHTML(g, false)).join("")}` : ""}
        ${!groups.length ? '<div class="empty-state"><p>Aucun groupe. Créez le premier !</p></div>' : ""}
      </div>`;
	},

	groupItemHTML(g, isMember) {
		const isOwner = g.createdBy === currentUser.id;
		return `
      <div class="group-item">
        <div class="group-icon">${g.emoji || String.fromCodePoint(0x1f4ac)}</div>
        <div style="flex:1;cursor:pointer" onclick="V.openGroup('${g.id}')">
          <div style="font-size:14px;font-weight:500">${esc(g.name)}</div>
          <div style="font-size:12px;color:var(--text3)">${(g.members || []).length} membre${(g.members || []).length > 1 ? "s" : ""}</div>
        </div>
        <div style="display:flex;gap:6px">
          ${
						isMember
							? `<button class="btn-secondary" style="font-size:12px;padding:6px 10px" onclick="V.openGroup('${g.id}')">Ouvrir</button>
               <button class="btn-secondary" style="font-size:12px;padding:6px 10px" onclick="V.manageGroup('${g.id}')">&#9881;</button>
               ${
									isOwner
										? `<button class="btn-danger" style="font-size:12px;padding:6px 10px" onclick="V.deleteGroup('${g.id}')">Suppr.</button>`
										: `<button class="btn-secondary" style="font-size:12px;padding:6px 10px;color:var(--danger)" onclick="V.leaveGroup('${g.id}')">Quitter</button>`
								}`
							: `<button class="btn-follow" onclick="V.joinGroup('${g.id}')">Rejoindre</button>`
					}
        </div>
      </div>`;
	},

	openGroup(groupId) {
		this.go("chat", { uid: "__group__", cid: groupId, groupId: groupId });
	},

	async joinGroup(groupId) {
		await updateDoc(doc(db, "groups", groupId), {
			members: arrayUnion(currentUser.id),
		});
		this.go("groups");
	},

	async leaveGroup(groupId) {
		if (!confirm("Quitter ce groupe ?")) return;
		await updateDoc(doc(db, "groups", groupId), {
			members: arrayRemove(currentUser.id),
		});
		this.go("groups");
	},

	async deleteGroup(groupId) {
		if (!confirm("Supprimer ce groupe définitivement ?")) return;
		await deleteDoc(doc(db, "groups", groupId));
		this.go("groups");
	},

	async manageGroup(groupId) {
		const snap = await getDoc(doc(db, "groups", groupId));
		if (!snap.exists()) return;
		const g = { id: snap.id, ...snap.data() };
		const usersSnap = await getDocs(collection(db, "users"));
		const allUsers = usersSnap.docs
			.map((d) => ({ id: d.id, ...d.data() }))
			.filter((u) => !u.banned);
		const members = g.members || [];
		const nonMembers = allUsers.filter(
			(u) => !members.includes(u.id) && u.id !== currentUser.id,
		);

		const membersList = members
			.map((uid) => {
				const u = allUsers.find((x) => x.id === uid);
				if (!u) return "";
				return `
        <div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--border)">
          ${avatarHTML(u)}
          <div style="flex:1"><div style="font-size:13px;font-weight:500">${esc(u.name)}</div><div style="font-size:12px;color:var(--text3)">@${esc(u.handle)}</div></div>
          ${
						uid !== currentUser.id && g.createdBy === currentUser.id
							? `<button class="btn-secondary" style="font-size:11px;padding:4px 8px;color:var(--danger)" onclick="V.removeMember('${groupId}','${uid}')">Retirer</button>`
							: uid === currentUser.id
								? '<span style="font-size:11px;color:var(--text3)">Vous</span>'
								: ""
					}
        </div>`;
			})
			.join("");

		const addList = nonMembers
			.slice(0, 20)
			.map(
				(u) => `
      <div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--border)">
        ${avatarHTML(u)}
        <div style="flex:1"><div style="font-size:13px;font-weight:500">${esc(u.name)}</div><div style="font-size:12px;color:var(--text3)">@${esc(u.handle)}</div></div>
        <button class="btn-follow" style="font-size:11px;padding:4px 10px" onclick="V.addMember('${groupId}','${u.id}')">Inviter</button>
      </div>`,
			)
			.join("");

		this.showModal(`
      <div class="modal-title">${esc(g.emoji || "")} ${esc(g.name)}</div>
      <div class="tab-bar" style="margin-bottom:12px">
        <div class="tab active" id="tab-members" onclick="V.switchGroupTab('members')">Membres (${members.length})</div>
        <div class="tab" id="tab-invite" onclick="V.switchGroupTab('invite')">Inviter</div>
      </div>
      <div id="group-tab-members">${membersList || '<p style="color:var(--text3);font-size:13px">Aucun membre.</p>'}</div>
      <div id="group-tab-invite" style="display:none">${addList || '<p style="color:var(--text3);font-size:13px">Tous les utilisateurs sont déjà membres.</p>'}</div>
    `);
	},

	switchGroupTab(tab) {
		document
			.querySelectorAll("#modal-content .tab")
			.forEach((t) => t.classList.remove("active"));
		document.getElementById("tab-" + tab)?.classList.add("active");
		document.getElementById("group-tab-members").style.display =
			tab === "members" ? "block" : "none";
		document.getElementById("group-tab-invite").style.display =
			tab === "invite" ? "block" : "none";
	},

	async addMember(groupId, userId) {
		await updateDoc(doc(db, "groups", groupId), {
			members: arrayUnion(userId),
		});
		const btn = event?.target;
		if (btn) {
			btn.textContent = "Ajouté !";
			btn.disabled = true;
			btn.style.opacity = "0.5";
		}
	},

	async removeMember(groupId, userId) {
		if (!confirm("Retirer ce membre du groupe ?")) return;
		await updateDoc(doc(db, "groups", groupId), {
			members: arrayRemove(userId),
		});
		this.closeModal();
		this.manageGroup(groupId);
	},

	showCreateGroupModal() {
		const emojis = [
			String.fromCodePoint(0x1f3a8),
			String.fromCodePoint(0x1f4bb),
			String.fromCodePoint(0x1f3b5),
			String.fromCodePoint(0x1f3ae),
			String.fromCodePoint(0x1f4da),
			String.fromCodePoint(0x1f3c3),
			String.fromCodePoint(0x1f355),
			String.fromCodePoint(0x2708),
			String.fromCodePoint(0x1f4a1),
			String.fromCodePoint(0x1f33f),
		];
		this.showModal(`
      <div class="modal-title">Créer un groupe</div>
      <div class="form-group">
        <label class="form-label">Nom du groupe</label>
        <input type="text" class="form-input" id="group-name" placeholder="Mon groupe"/>
      </div>
      <div class="form-group">
        <label class="form-label">Emoji</label>
        <div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:4px" id="emoji-grid">
          ${emojis
						.map(
							(e, i) =>
								`<button onclick="V.selectEmoji(this,'${e}')"
              style="font-size:22px;background:var(--bg3);border:2px solid ${i === 0 ? "var(--accent)" : "transparent"};border-radius:8px;padding:6px;cursor:pointer;line-height:1">${e}</button>`,
						)
						.join("")}
        </div>
        <input type="hidden" id="group-emoji" id="group-emoji-hidden">
      </div>
      <div style="display:flex;gap:10px;margin-top:20px">
        <button class="btn-secondary" onclick="V.closeModal()">Annuler</button>
        <button class="btn-primary" onclick="V.createGroup()">Créer</button>
      </div>`);
	},

	selectEmoji(btn, emoji) {
		document
			.querySelectorAll("#emoji-grid button")
			.forEach((b) => (b.style.borderColor = "transparent"));
		btn.style.borderColor = "var(--accent)";
		$("group-emoji").value = emoji;
	},

	async createGroup() {
		const name = $("group-name")?.value?.trim();
		const emoji = $("group-emoji")?.value || String.fromCodePoint(0x1f4ac);
		if (!name) {
			$("group-name")?.focus();
			return;
		}
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
			// Pas de filtre where() pour éviter les index Firestore
			const snap = await getDocs(
				query(
					collection(db, "posts"),
					orderBy("createdAt", "desc"),
					limit(100),
				),
			);
			const posts = snap.docs
				.map((d) => ({ id: d.id, ...d.data() }))
				.filter(
					(p) =>
						p.type === "public" &&
						p.content?.toLowerCase().includes(q.toLowerCase()),
				);
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
				orderBy("createdAt", "desc"),
				limit(50),
			),
		);
		const notifs = snap.docs
			.map((d) => ({ id: d.id, ...d.data() }))
			.filter((n) => n.toUid === currentUser.id);

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
			query(collection(db, "posts"), orderBy("createdAt", "desc"), limit(50)),
		);
		const posts = postsSnap.docs
			.map((d) => ({ id: d.id, ...d.data() }))
			.filter((p) => p.authorId === uid && (p.type === "public" || isMe));

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
      <div style="max-width:900px;margin:0 auto;padding:0 16px 60px">
        <div class="page-header">
          <div class="page-title">&#128737;&#65039; Administration</div>
          <div class="page-subtitle">Panneau de gestion AEVOX</div>
        </div>

        <!-- Onglets admin -->
        <div class="tab-bar" style="margin:16px 0 0">
          <div class="tab active" id="atab-overview"  onclick="V.adminTab('overview')">&#128200; Vue</div>
          <div class="tab"        id="atab-users"     onclick="V.adminTab('users')">&#128101; Membres</div>
          <div class="tab"        id="atab-posts"     onclick="V.adminTab('posts')">&#128196; Posts</div>
          <div class="tab"        id="atab-groups"    onclick="V.adminTab('groups')">&#128101; Groupes</div>
          <div class="tab"        id="atab-roles"     onclick="V.adminTab('roles')">&#127894;&#65039; R\u00f4les</div>
          <div class="tab"        id="atab-announce"  onclick="V.adminTab('announce')">&#128226; Annonces</div>
        </div>

        <div id="admin-tab-content" style="margin-top:16px">
          <div class="loading-screen" style="height:200px"><div class="spinner"></div></div>
        </div>
      </div>`;

		this.adminTab("overview");
	},

	async adminTab(tab) {
		// Mettre à jour les onglets
		document
			.querySelectorAll('[id^="atab-"]')
			.forEach((t) => t.classList.remove("active"));
		const activeTab = $("atab-" + tab);
		if (activeTab) activeTab.classList.add("active");
		const content = $("admin-tab-content");
		if (!content) return;
		content.innerHTML =
			'<div class="loading-screen" style="height:200px"><div class="spinner"></div></div>';

		switch (tab) {
			case "overview":
				await this.adminOverview(content);
				break;
			case "users":
				await this.adminUsers(content);
				break;
			case "posts":
				await this.adminPosts(content);
				break;
			case "groups":
				await this.adminGroups(content);
				break;
			case "roles":
				await this.adminRoles(content);
				break;
			case "announce":
				await this.adminAnnounce(content);
				break;
		}
	},

	// ---- VUE D'ENSEMBLE ----
	async adminOverview(el) {
		const [usersSnap, postsSnap, groupsSnap, announceSnap] = await Promise.all([
			getDocs(collection(db, "users")),
			getDocs(collection(db, "posts")),
			getDocs(collection(db, "groups")),
			getDocs(collection(db, "announcements")),
		]);
		const users = usersSnap.docs.map((d) => d.data());
		const posts = postsSnap.docs.map((d) => ({ id: d.id, ...d.data() }));

		el.innerHTML = `
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin-bottom:20px">
        ${[
					{ val: users.length, lbl: "Utilisateurs", color: "#7c6af7" },
					{
						val: users.filter((u) => !u.banned).length,
						lbl: "Actifs",
						color: "#5dd89e",
					},
					{
						val: users.filter((u) => u.banned).length,
						lbl: "Bannis",
						color: "#f26b6b",
					},
					{
						val: users.filter((u) => u.role === "admin").length,
						lbl: "Admins",
						color: "#f5a623",
					},
					{ val: posts.length, lbl: "Publications", color: "#4a9eff" },
					{ val: groupsSnap.size, lbl: "Groupes", color: "#d46ef5" },
					{ val: announceSnap.size, lbl: "Annonces", color: "#4ecb7a" },
				]
					.map(
						(s) => `
          <div class="admin-stat">
            <div class="admin-stat-val" style="color:${s.color}">${s.val}</div>
            <div class="admin-stat-lbl">${s.lbl}</div>
          </div>`,
					)
					.join("")}
      </div>

      <!-- Dernières inscriptions -->
      <div class="settings-section">
        <h3>&#128197; Dernières inscriptions</h3>
        ${users
					.slice(-5)
					.reverse()
					.map(
						(u) => `
          <div style="display:flex;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid var(--border)">
            ${avatarHTML(u)}
            <div style="flex:1">
              <div style="font-size:14px;font-weight:500">${esc(u.name)}</div>
              <div style="font-size:12px;color:var(--text3)">@${esc(u.handle || "")} &bull; ${esc(u.email || "")}</div>
            </div>
            <span class="badge badge-${u.role === "admin" ? "admin" : u.banned ? "banned" : "user"}">
              ${u.role === "admin" ? "Admin" : u.banned ? "Banni" : "Membre"}
            </span>
          </div>`,
					)
					.join("")}
      </div>

      <!-- Derniers posts -->
      <div class="settings-section">
        <h3>&#128196; Dernières publications</h3>
        <div id="admin-recent-posts"><div class="spinner"></div></div>
      </div>`;

		try {
			const htmlParts = await Promise.all(
				posts.slice(0, 5).map((p) => this.postHTML(p)),
			);
			const c = $("admin-recent-posts");
			if (c)
				c.innerHTML =
					htmlParts.filter(Boolean).join("") ||
					'<p style="color:var(--text3)">Aucune publication.</p>';
		} catch {}
	},

	// ---- GESTION DES MEMBRES ----
	async adminUsers(el) {
		const snap = await getDocs(collection(db, "users"));
		const users = snap.docs.map((d) => ({ id: d.id, ...d.data() }));

		el.innerHTML = `
      <div class="settings-section" style="overflow-x:auto">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
          <h3>&#128101; Gestion des membres (${users.length})</h3>
          <input type="text" class="form-input" placeholder="&#128269; Rechercher..."
            style="width:200px;padding:8px 12px"
            oninput="V.filterAdminUsers(this.value)"/>
        </div>
        <table class="admin-table" id="admin-users-table">
          <thead>
            <tr>
              <th>Utilisateur</th>
              <th>R\u00f4le</th>
              <th>Email</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody id="admin-users-body">
            ${users.map((u) => this.adminUserRow(u)).join("")}
          </tbody>
        </table>
      </div>`;

		// Stocker pour la recherche
		window._adminUsers = users;
	},

	adminUserRow(u) {
		const roleColor = u.banned
			? "#f26b6b"
			: u.role === "admin"
				? "#7c6af7"
				: u.customRole
					? "#f5a623"
					: "#888";
		const roleLabel = u.banned
			? "&#128683; Banni"
			: u.role === "admin"
				? "&#128737; Admin"
				: u.customRole
					? esc(u.customRole)
					: "Membre";
		return `
      <tr id="urow-${u.id}" style="${u.banned ? "opacity:0.55" : ""}">
        <td>
          <div style="display:flex;align-items:center;gap:8px">
            ${avatarHTML(u)}
            <div>
              <div style="font-weight:500;font-size:13px">${esc(u.name)}</div>
              <div style="font-size:12px;color:var(--text3)">@${esc(u.handle || "")}</div>
              ${u.banReason ? `<div style="font-size:11px;color:#f26b6b">Raison : ${esc(u.banReason)}</div>` : ""}
            </div>
          </div>
        </td>
        <td>
          <span class="badge" style="background:${roleColor}22;color:${roleColor}">${roleLabel}</span>
        </td>
        <td style="font-size:12px;color:var(--text3)">${esc(u.email || "")}</td>
        <td>
          ${
						u.id !== currentUser.id
							? `
            <div style="display:flex;gap:6px;flex-wrap:wrap">
              <button class="btn-secondary" style="font-size:11px;padding:4px 8px"
                onclick="V.showRoleModal('${u.id}','${esc(u.name)}','${esc(u.role || "")}','${esc(u.customRole || "")}')">
                R\u00f4le
              </button>
              <button class="btn-secondary" style="font-size:11px;padding:4px 8px"
                onclick="V.go('profile','${u.id}')">
                Profil
              </button>
              <button onclick="V.showBanModal('${u.id}','${esc(u.name)}',${!!u.banned})"
                style="font-size:11px;padding:4px 8px;border-radius:6px;cursor:pointer;border:1px solid ${u.banned ? "rgba(93,216,158,0.3)" : "rgba(242,107,107,0.3)"};background:${u.banned ? "rgba(93,216,158,0.08)" : "rgba(242,107,107,0.08)"};color:${u.banned ? "#5dd89e" : "#f26b6b"}">
                ${u.banned ? "D\u00e9bannir" : "Bannir"}
              </button>
            </div>`
							: '<span style="font-size:12px;color:var(--text3)">Vous</span>'
					}
        </td>
      </tr>`;
	},

	filterAdminUsers(q) {
		const users = (window._adminUsers || []).filter(
			(u) =>
				!q ||
				u.name?.toLowerCase().includes(q.toLowerCase()) ||
				u.handle?.toLowerCase().includes(q.toLowerCase()) ||
				u.email?.toLowerCase().includes(q.toLowerCase()),
		);
		const body = $("admin-users-body");
		if (body) body.innerHTML = users.map((u) => this.adminUserRow(u)).join("");
	},

	// ---- GESTION DES POSTS ----
	async adminPosts(el) {
		el.innerHTML = `
      <div class="settings-section">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
          <h3>&#128196; Toutes les publications</h3>
          <div style="display:flex;gap:8px">
            <select class="compose-select" onchange="V.filterAdminPosts(this.value)" id="admin-posts-filter">
              <option value="all">Tous</option>
              <option value="public">Public</option>
              <option value="followers">Abonn\u00e9s</option>
            </select>
          </div>
        </div>
        <div id="admin-all-posts">
          <div class="loading-screen" style="height:150px"><div class="spinner"></div></div>
        </div>
      </div>`;

		await this.filterAdminPosts("all");
	},

	async filterAdminPosts(filter) {
		const snap = await getDocs(
			query(collection(db, "posts"), orderBy("createdAt", "desc"), limit(100)),
		);
		let posts = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
		if (filter !== "all") posts = posts.filter((p) => p.type === filter);
		const c = $("admin-all-posts");
		if (!c) return;
		if (!posts.length) {
			c.innerHTML = '<div class="empty-state"><p>Aucune publication.</p></div>';
			return;
		}
		const htmlParts = await Promise.all(posts.map((p) => this.postHTML(p)));
		c.innerHTML = htmlParts.filter(Boolean).join("");
	},

	// ---- GESTION DES GROUPES ----
	async adminGroups(el) {
		const snap = await getDocs(collection(db, "groups"));
		const groups = snap.docs.map((d) => ({ id: d.id, ...d.data() }));

		el.innerHTML = `
      <div class="settings-section">
        <h3>&#128101; Tous les groupes (${groups.length})</h3>
        ${
					!groups.length
						? '<div class="empty-state"><p>Aucun groupe.</p></div>'
						: groups
								.map(
									(g) => `
            <div style="background:var(--bg3);border-radius:var(--radius-sm);padding:14px;margin-bottom:10px">
              <div style="display:flex;align-items:center;gap:12px">
                <div class="group-icon" style="flex-shrink:0">${g.emoji || "&#128172;"}</div>
                <div style="flex:1">
                  <div style="font-weight:500;font-size:15px">${esc(g.name)}</div>
                  <div style="font-size:12px;color:var(--text3);margin-top:2px">
                    ${(g.members || []).length} membre(s) &bull; Cr\u00e9\u00e9 par ${esc(g.createdBy || "?")}
                  </div>
                </div>
                <div style="display:flex;gap:6px">
                  <button class="btn-secondary" style="font-size:12px;padding:6px 10px"
                    onclick="V.adminGroupMembers('${g.id}','${esc(g.name)}',${JSON.stringify(g.members || []).replace(/"/g, "'")})">
                    Membres
                  </button>
                  <button onclick="V.adminDeleteGroup('${g.id}','${esc(g.name)}')"
                    style="font-size:12px;padding:6px 10px;border-radius:6px;cursor:pointer;border:1px solid rgba(242,107,107,0.3);background:rgba(242,107,107,0.08);color:#f26b6b">
                    Supprimer
                  </button>
                </div>
              </div>
            </div>`,
								)
								.join("")
				}
      </div>`;
	},

	async adminGroupMembers(groupId, groupName, members) {
		// Récupérer les noms des membres
		const usersSnap = await getDocs(collection(db, "users"));
		const allUsers = usersSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
		const memberUsers = allUsers.filter((u) => members.includes(u.id));
		const nonMembers = allUsers.filter(
			(u) => !members.includes(u.id) && !u.banned,
		);

		this.showModal(`
      <div class="modal-title">Membres de "${esc(groupName)}"</div>
      <div style="margin-bottom:16px">
        <div style="font-size:13px;color:var(--text3);margin-bottom:8px;font-weight:500">Membres actuels</div>
        ${
					memberUsers
						.map(
							(u) => `
          <div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--border)">
            ${avatarHTML(u)}
            <div style="flex:1">
              <div style="font-size:13px;font-weight:500">${esc(u.name)}</div>
              <div style="font-size:12px;color:var(--text3)">@${esc(u.handle || "")}</div>
            </div>
            <button onclick="V.adminRemoveFromGroup('${groupId}','${u.id}','${esc(groupName)}')"
              style="font-size:11px;padding:4px 8px;border-radius:6px;cursor:pointer;border:1px solid rgba(242,107,107,0.3);background:rgba(242,107,107,0.08);color:#f26b6b">
              Retirer
            </button>
          </div>`,
						)
						.join("") ||
					'<p style="color:var(--text3);font-size:13px">Aucun membre.</p>'
				}
      </div>
      ${
				nonMembers.length
					? `
        <div>
          <div style="font-size:13px;color:var(--text3);margin-bottom:8px;font-weight:500">Ajouter un membre</div>
          ${nonMembers
						.map(
							(u) => `
            <div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--border)">
              ${avatarHTML(u)}
              <div style="flex:1">
                <div style="font-size:13px;font-weight:500">${esc(u.name)}</div>
              </div>
              <button class="btn-secondary" style="font-size:11px;padding:4px 8px"
                onclick="V.adminAddToGroup('${groupId}','${u.id}','${esc(groupName)}')">
                Ajouter
              </button>
            </div>`,
						)
						.join("")}
        </div>`
					: ""
			}
      <div class="btn-row" style="margin-top:16px">
        <button class="btn-secondary" onclick="V.closeModal()">Fermer</button>
      </div>`);
	},

	async adminRemoveFromGroup(groupId, userId, groupName) {
		await updateDoc(doc(db, "groups", groupId), {
			members: arrayRemove(userId),
		});
		this.closeModal();
		this.adminTab("groups");
	},

	async adminAddToGroup(groupId, userId, groupName) {
		await updateDoc(doc(db, "groups", groupId), {
			members: arrayUnion(userId),
		});
		this.closeModal();
		this.adminTab("groups");
	},

	async adminDeleteGroup(groupId, groupName) {
		this.showModal(`
      <div class="modal-title">Supprimer ce groupe ?</div>
      <p style="font-size:14px;color:var(--text2);margin-bottom:20px">
        Le groupe <strong>${esc(groupName)}</strong> sera supprim\u00e9 d\u00e9finitivement ainsi que tous ses messages.
      </p>
      <div class="btn-row">
        <button class="btn-secondary" onclick="V.closeModal()">Annuler</button>
        <button class="btn-danger" onclick="V.confirmDeleteGroup('${groupId}')">Supprimer</button>
      </div>`);
	},

	async confirmDeleteGroup(groupId) {
		await deleteDoc(doc(db, "groups", groupId));
		this.closeModal();
		this.adminTab("groups");
	},

	// ---- GESTION DES RÔLES ----
	async adminRoles(el) {
		const snap = await getDocs(collection(db, "custom_roles"));
		const customRoles = snap.docs.map((d) => ({ id: d.id, ...d.data() }));

		el.innerHTML = `
      <div class="settings-section">
        <h3>&#127894;&#65039; R\u00f4les syst\u00e8me</h3>
        <div style="display:flex;flex-direction:column;gap:8px;margin-bottom:16px">
          ${[
						{
							name: "admin",
							label: "&#128737; Admin",
							color: "#7c6af7",
							desc: "Acc\u00e8s complet au panneau admin",
						},
						{
							name: "certified",
							label: "&#9989; Certifi\u00e9",
							color: "#4a9eff",
							desc: "Compte v\u00e9rifi\u00e9 et certifi\u00e9",
						},
						{
							name: "user",
							label: "&#128100; Membre",
							color: "#888",
							desc: "Membre standard",
						},
					]
						.map(
							(r) => `
            <div style="display:flex;align-items:center;gap:12px;padding:12px;background:var(--bg3);border-radius:var(--radius-sm)">
              <span class="badge" style="background:${r.color}22;color:${r.color};font-size:13px">${r.label}</span>
              <div style="flex:1;font-size:13px;color:var(--text2)">${r.desc}</div>
              <span style="font-size:11px;color:var(--text3)">Syst\u00e8me</span>
            </div>`,
						)
						.join("")}
        </div>
      </div>

      <div class="settings-section">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
          <h3>&#10024; R\u00f4les personnalis\u00e9s (${customRoles.length})</h3>
          <button class="btn-primary" style="font-size:13px;padding:8px 14px"
            onclick="V.showCreateRoleModal()">+ Cr\u00e9er un r\u00f4le</button>
        </div>
        <div id="custom-roles-list">
          ${
						!customRoles.length
							? '<div class="empty-state" style="padding:24px"><p>Aucun r\u00f4le personnalis\u00e9.</p></div>'
							: customRoles
									.map(
										(r) => `
              <div style="display:flex;align-items:center;gap:12px;padding:12px;background:var(--bg3);border-radius:var(--radius-sm);margin-bottom:8px">
                <span class="badge" style="background:${esc(r.color || "#888")}22;color:${esc(r.color || "#888")};font-size:13px">${esc(r.icon || "")} ${esc(r.name)}</span>
                <div style="flex:1;font-size:13px;color:var(--text2)">${esc(r.description || "")}</div>
                <button onclick="V.deleteCustomRole('${r.id}','${esc(r.name)}')"
                  style="font-size:11px;padding:4px 8px;border-radius:6px;cursor:pointer;border:1px solid rgba(242,107,107,0.3);background:rgba(242,107,107,0.08);color:#f26b6b">
                  Supprimer
                </button>
              </div>`,
									)
									.join("")
					}
        </div>
      </div>`;
	},

	showCreateRoleModal() {
		this.showModal(`
      <div class="modal-title">Cr\u00e9er un r\u00f4le personnalis\u00e9</div>
      <div class="form-group">
        <label class="form-label">Nom du r\u00f4le</label>
        <input type="text" class="form-input" id="role-name" placeholder="Ex: Mod\u00e9rateur, VIP, Partenaire..."/>
      </div>
      <div class="form-group">
        <label class="form-label">Ic\u00f4ne (emoji)</label>
        <input type="text" class="form-input" id="role-icon" placeholder="Ex: &#11088;, &#127381;, &#128081;..."/>
      </div>
      <div class="form-group">
        <label class="form-label">Couleur</label>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:4px">
          ${[
						"#7c6af7",
						"#4a9eff",
						"#5dd89e",
						"#f5a623",
						"#f26b6b",
						"#d46ef5",
						"#4ecb7a",
						"#ff6b9d",
					]
						.map(
							(c) =>
								`<button onclick="document.getElementById('role-color').value='${c}';document.querySelectorAll('.color-pick').forEach(b=>b.style.outline='none');this.style.outline='2px solid white'"
              class="color-pick" style="width:28px;height:28px;border-radius:50%;background:${c};border:none;cursor:pointer"></button>`,
						)
						.join("")}
          <input type="color" id="role-color" value="#7c6af7"
            style="width:28px;height:28px;border-radius:50%;border:none;cursor:pointer;padding:0"/>
        </div>
      </div>
      <div class="form-group">
        <label class="form-label">Description</label>
        <input type="text" class="form-input" id="role-desc" placeholder="Description du r\u00f4le..."/>
      </div>
      <div class="btn-row">
        <button class="btn-secondary" onclick="V.closeModal()">Annuler</button>
        <button class="btn-primary" onclick="V.saveCustomRole()">Cr\u00e9er</button>
      </div>`);
	},

	async saveCustomRole() {
		const name = $("role-name")?.value?.trim();
		const icon = $("role-icon")?.value?.trim();
		const color = $("role-color")?.value;
		const desc = $("role-desc")?.value?.trim();
		if (!name) return;
		await addDoc(collection(db, "custom_roles"), {
			name,
			icon,
			color,
			description: desc,
			createdBy: currentUser.id,
			createdAt: serverTimestamp(),
		});
		this.closeModal();
		this.adminTab("roles");
	},

	async deleteCustomRole(roleId, roleName) {
		if (!confirm(`Supprimer le r\u00f4le "${roleName}" ?`)) return;
		await deleteDoc(doc(db, "custom_roles", roleId));
		this.adminTab("roles");
	},

	// Modal pour assigner un rôle à un utilisateur
	async showRoleModal(uid, name, currentRole, currentCustomRole) {
		const snap = await getDocs(collection(db, "custom_roles"));
		const customRoles = snap.docs.map((d) => ({ id: d.id, ...d.data() }));

		this.showModal(`
      <div class="modal-title">R\u00f4le de ${esc(name)}</div>
      <div class="form-group">
        <label class="form-label">R\u00f4le syst\u00e8me</label>
        <select class="form-input" id="role-system">
          <option value="user"  ${currentRole !== "admin" ? "selected" : ""}>&#128100; Membre</option>
          <option value="admin" ${currentRole === "admin" ? "selected" : ""}>&#128737; Admin</option>
        </select>
      </div>
      <div class="form-group">
        <label class="form-label">R\u00f4le personnalis\u00e9</label>
        <select class="form-input" id="role-custom">
          <option value="">Aucun</option>
          ${customRoles
						.map(
							(r) =>
								`<option value="${esc(r.name)}" ${currentCustomRole === r.name ? "selected" : ""}>${esc(r.icon || "")} ${esc(r.name)}</option>`,
						)
						.join("")}
        </select>
      </div>
      <div class="btn-row">
        <button class="btn-secondary" onclick="V.closeModal()">Annuler</button>
        <button class="btn-primary" onclick="V.applyRole('${uid}')">Appliquer</button>
      </div>`);
	},

	async applyRole(uid) {
		const systemRole = $("role-system")?.value;
		const customRole = $("role-custom")?.value;
		await updateDoc(doc(db, "users", uid), {
			role: systemRole,
			customRole: customRole || null,
		});
		this.closeModal();
		this.adminTab("users");
	},

	// ---- ANNONCES ----
	async adminAnnounce(el) {
		const snap = await getDocs(
			query(
				collection(db, "announcements"),
				orderBy("createdAt", "desc"),
				limit(20),
			),
		);
		const anns = snap.docs.map((d) => ({ id: d.id, ...d.data() }));

		el.innerHTML = `
      <div class="settings-section">
        <h3>&#128226; Nouvelle annonce</h3>
        <div class="form-group">
          <label class="form-label">Titre</label>
          <input type="text" class="form-input" id="ann-title" placeholder="Titre de l'annonce..."/>
        </div>
        <div class="form-group">
          <label class="form-label">Message</label>
          <textarea class="form-input form-textarea" id="ann-body" placeholder="Contenu de l'annonce..." style="min-height:100px"></textarea>
        </div>
        <div class="form-group">
          <label class="form-label">Type</label>
          <select class="form-input" id="ann-type">
            <option value="info">&#8505;&#65039; Information</option>
            <option value="success">&#9989; Bonne nouvelle</option>
            <option value="warn">&#9888;&#65039; Avertissement</option>
            <option value="danger">&#128683; Urgent</option>
          </select>
        </div>
        <button class="btn-primary" onclick="V.publishAnnouncement()">&#128226; Publier l'annonce</button>
        <div id="ann-msg" style="margin-top:10px"></div>
      </div>

      <div class="settings-section">
        <h3>&#128195; Annonces publi\u00e9es (${anns.length})</h3>
        ${
					!anns.length
						? '<div class="empty-state" style="padding:24px"><p>Aucune annonce.</p></div>'
						: anns
								.map((a) => {
									const colors = {
										info: "#4a9eff",
										success: "#5dd89e",
										warn: "#f5a623",
										danger: "#f26b6b",
									};
									const icons = {
										info: "ℹ️",
										success: "✅",
										warn: "⚠️",
										danger: "🚫",
									};
									const c = colors[a.type] || "#888";
									return `
              <div style="background:${c}11;border:1px solid ${c}33;border-radius:var(--radius-sm);padding:14px;margin-bottom:10px">
                <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px">
                  <div style="flex:1">
                    <div style="font-weight:600;font-size:14px;color:${c}">${icons[a.type] || ""} ${esc(a.title)}</div>
                    <div style="font-size:13px;color:var(--text2);margin-top:6px">${esc(a.body)}</div>
                    <div style="font-size:11px;color:var(--text3);margin-top:6px">${timeAgo(a.createdAt)}</div>
                  </div>
                  <button onclick="V.deleteAnnouncement('${a.id}')"
                    style="font-size:11px;padding:4px 8px;border-radius:6px;cursor:pointer;border:1px solid rgba(242,107,107,0.3);background:rgba(242,107,107,0.08);color:#f26b6b;flex-shrink:0">
                    Supprimer
                  </button>
                </div>
              </div>`;
								})
								.join("")
				}
      </div>`;
	},

	async publishAnnouncement() {
		const title = $("ann-title")?.value?.trim();
		const body = $("ann-body")?.value?.trim();
		const type = $("ann-type")?.value || "info";
		if (!title || !body) {
			$("ann-msg").innerHTML =
				'<div class="alert alert-error">Titre et message requis.</div>';
			return;
		}
		await addDoc(collection(db, "announcements"), {
			title,
			body,
			type,
			authorId: currentUser.id,
			authorName: currentUser.name,
			createdAt: serverTimestamp(),
		});
		$("ann-msg").innerHTML =
			'<div class="alert alert-success">Annonce publi\u00e9e !</div>';
		if ($("ann-title")) $("ann-title").value = "";
		if ($("ann-body")) $("ann-body").value = "";
		setTimeout(() => this.adminTab("announce"), 1500);
	},

	async deleteAnnouncement(id) {
		await deleteDoc(doc(db, "announcements", id));
		this.adminTab("announce");
	},

	// Bannissement avec confirmation et raison
	showBanModal(uid, name, isBanned) {
		if (isBanned) {
			// Déjà banni → modal pour débannir
			this.showModal(`
        <div class="modal-title">D\u00e9bannir cet utilisateur</div>
        <div style="display:flex;align-items:center;gap:12px;padding:14px;background:var(--bg3);border-radius:var(--radius-sm);margin-bottom:16px">
          <div style="width:40px;height:40px;border-radius:50%;background:#5dd89e;display:flex;align-items:center;justify-content:center;font-weight:600;color:#fff">${esc(name[0])}</div>
          <div>
            <div style="font-weight:500">${esc(name)}</div>
            <div style="font-size:12px;color:#f26b6b">Compte actuellement banni</div>
          </div>
        </div>
        <p style="font-size:14px;color:var(--text2);margin-bottom:20px">
          En d\u00e9bannissant cet utilisateur, il pourra de nouveau se connecter et utiliser AEVOX.
        </p>
        <div class="btn-row">
          <button class="btn-secondary" onclick="V.closeModal()">Annuler</button>
          <button class="btn-primary" onclick="V.executeBan('${uid}', false, '')">
            D\u00e9bannir l'utilisateur
          </button>
        </div>`);
		} else {
			// Pas banni → modal pour bannir avec raison
			this.showModal(`
        <div class="modal-title">Bannir cet utilisateur</div>
        <div style="display:flex;align-items:center;gap:12px;padding:14px;background:var(--bg3);border-radius:var(--radius-sm);margin-bottom:16px">
          <div style="width:40px;height:40px;border-radius:50%;background:#7c6af7;display:flex;align-items:center;justify-content:center;font-weight:600;color:#fff">${esc(name[0])}</div>
          <div style="font-weight:500">${esc(name)}</div>
        </div>
        <div class="form-group">
          <label class="form-label">Raison du bannissement</label>
          <select class="form-input" id="ban-reason">
            <option value="spam">Spam ou pub non souhait\u00e9e</option>
            <option value="harcelement">Harc\u00e8lement ou comportement abusif</option>
            <option value="contenu">Contenu inappropri\u00e9</option>
            <option value="faux">Faux profil ou usurpation</option>
            <option value="autre">Autre raison</option>
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">D\u00e9tails (optionnel)</label>
          <textarea class="form-input form-textarea" id="ban-details"
            placeholder="Pr\u00e9cisez la raison..." style="min-height:60px"></textarea>
        </div>
        <div style="background:rgba(242,107,107,0.08);border:1px solid rgba(242,107,107,0.2);border-radius:var(--radius-sm);padding:12px;margin-bottom:16px">
          <div style="font-size:13px;color:#f26b6b;font-weight:500">&#9888;&#65039; Attention</div>
          <div style="font-size:13px;color:var(--text2);margin-top:4px">
            L'utilisateur sera imm\u00e9diatement d\u00e9connect\u00e9 et ne pourra plus acc\u00e9der \u00e0 AEVOX.
          </div>
        </div>
        <div class="btn-row">
          <button class="btn-secondary" onclick="V.closeModal()">Annuler</button>
          <button onclick="V.executeBan('${uid}', true, document.getElementById('ban-reason').value)"
            style="background:rgba(242,107,107,0.15);border:1px solid rgba(242,107,107,0.3);color:#f26b6b;padding:10px 18px;border-radius:var(--radius-sm);font-family:var(--font);font-size:14px;font-weight:500;cursor:pointer">
            Confirmer le bannissement
          </button>
        </div>`);
		}
	},

	async executeBan(uid, ban, reason) {
		const updates = {
			banned: ban,
			banReason: ban ? reason : null,
			bannedAt: ban ? serverTimestamp() : null,
			bannedBy: ban ? currentUser.id : null,
		};
		await updateDoc(doc(db, "users", uid), updates);
		this.closeModal();
		// Notification dans la console admin
		const msg = ban
			? `Utilisateur banni (raison: ${reason})`
			: "Utilisateur d\u00e9banni";
		console.log(`[AEVOX Admin] ${msg}`);
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
