// admin.js - admin page logic using Firebase RTDB
// Admin accounts defined here (5 admins)
const ADMINS = [
  { user: "admin1", pass: "Pass@123" },
  { user: "admin2", pass: "Alpha!22" },
  { user: "admin3", pass: "Bravo#33" },
  { user: "manager", pass: "Mng2025!" },
  { user: "super", pass: "Super$1" }
];

const STORAGE_ROOT = "vc_rooms";
const db = window._firebase.db;

const adminUser = document.getElementById("admin-user");
const adminPass = document.getElementById("admin-pass");
const loginBtn = document.getElementById("admin-login");
const loginScreen = document.getElementById("login-screen");
const dashboard = document.getElementById("dashboard");
const roomList = document.getElementById("room-list");
const searchInput = document.getElementById("search-input");
const refreshBtn = document.getElementById("refresh-btn");
const logoutBtn = document.getElementById("logout-btn");

let currentAdmin = null;
let roomsRef = db.ref(STORAGE_ROOT);
let roomsListener = null;

function renderRooms(snapshot, filter=""){
  const queries = filter.trim().toLowerCase();
  roomList.innerHTML = "";
  if(!snapshot || !snapshot.exists()){
    roomList.innerHTML = "<div class='hint'>Tidak ada ruangan aktif.</div>";
    return;
  }
  const val = snapshot.val();
  const entries = Object.entries(val).sort((a,b)=> (a[1].createdAt < b[1].createdAt) ? 1 : -1);
  for(const [k,r] of entries){
    const userCount = r.users ? Object.keys(r.users).length : 0;
    const created = r.createdAt ? new Date(r.createdAt).toLocaleString() : "-";
    // filter
    let keep = true;
    if(queries){
      if(!isNaN(Number(queries))){
        keep = Number(queries) === userCount;
      } else keep = k.toLowerCase().includes(queries);
    }
    if(!keep) continue;

    const item = document.createElement("div");
    item.className = "room-item";
    const shareLink = `${location.origin.replace(/\/admin\.html.*$/,"") || ""}${"/index.html"}?room=${encodeURIComponent(k)}`;
    item.innerHTML = `
      <div>
        <div><strong>${k}</strong> <a class="room-link" href="${shareLink}" target="_blank">[link]</a></div>
        <div class="room-meta">Users: ${userCount} • Created: ${created}</div>
      </div>
      <div style="display:flex;gap:8px;align-items:center;">
        <button class="small-btn" data-room="${k}" data-action="inspect">Inspect</button>
        <button class="small-btn danger" data-room="${k}" data-action="delete">Delete</button>
      </div>
    `;
    roomList.appendChild(item);
  }
}

loginBtn.addEventListener("click", ()=>{
  const u = adminUser.value.trim();
  const p = adminPass.value.trim();
  const ok = ADMINS.find(a=>a.user === u && a.pass === p);
  if(ok){
    currentAdmin = ok.user;
    loginScreen.classList.add("hidden");
    dashboard.classList.remove("hidden");
    startRealtime();
  } else {
    alert("Login salah.");
  }
});

logoutBtn.addEventListener("click", ()=>{
  stopRealtime();
  dashboard.classList.add("hidden");
  loginScreen.classList.remove("hidden");
  adminUser.value = ""; adminPass.value = "";
  currentAdmin = null;
});

refreshBtn.addEventListener("click", ()=> {
  roomsRef.once("value").then(snap => renderRooms(snap, searchInput.value||""));
});
searchInput.addEventListener("input", ()=> {
  // quick filter locally by re-rendering from last snapshot (we use live listener so just call render with snapshot)
  roomsRef.once("value").then(snap => renderRooms(snap, searchInput.value||""));
});

// delegate clicks
roomList.addEventListener("click", (e)=>{
  const btn = e.target.closest("button");
  if(!btn) return;
  const action = btn.dataset.action;
  const room = btn.dataset.room;
  if(action === "delete"){
    if(!confirm("Hapus ruangan "+room+" ? Ini akan mengeluarkan semua user.")) return;
    // delete room and its signals
    db.ref(`vc_rooms/${room}`).remove();
    db.ref(`signals/${room}`).remove();
    // notify room deletion via signals (to ensure clients get immediate message)
    db.ref(`signals/${room}`).push({ type: "room-deleted", from: "admin", by: currentAdmin, ts: Date.now() });
    // re-render will update via realtime listener
  } else if(action === "inspect"){
    db.ref(`vc_rooms/${room}`).once("value").then(snap=>{
      if(!snap.exists()){ alert("Ruangan tidak ditemukan."); return; }
      const r = snap.val();
      const users = r.users ? Object.keys(r.users).map(u=>`${u}`).join("\n") : "<kosong>";
      alert(`Room ${room}\nCreated: ${r.createdAt}\nUsers (${r.users ? Object.keys(r.users).length : 0}):\n${users}`);
    });
  }
});

// realtime functions
function startRealtime(){
  // attach a listener to rooms root
  roomsListener = roomsRef.on("value", snap => renderRooms(snap, searchInput.value||""));
}

function stopRealtime(){
  if(roomsListener) roomsRef.off("value", roomsListener);
  roomsListener = null;
}