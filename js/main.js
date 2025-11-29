// main.js - UI glue for index.html using FirebaseVC
const el = (id)=>document.getElementById(id);
const roomInput = el("room-input");
const createBtn = el("create-room-btn");
const joinBtn = el("join-room-btn");
const pasteBtn = el("paste-room-btn");
const mainScreen = el("main-screen");
const vcScreen = el("vc-screen");
const roomDisplay = el("room-code-display");
const leaveBtn = el("leave-btn");
const muteBtn = el("mute-btn");
const camBtn = el("cam-btn");
const localVideo = el("localVideo");
const remotesDiv = el("remotes");
const statusDiv = el("status");
const shareArea = el("share-area");
const roomLinkA = el("room-link");
const copyLinkBtn = el("copy-link-btn");

let clientId = null;
let roomCode = null;
let manager = null;
let muted = false;
let camOff = false;

function showStatus(s){
  statusDiv.textContent = s;
}

createBtn.addEventListener("click", ()=>{
  const code = window.FirebaseVC.randString(Math.floor(Math.random()*3)+6);
  enterRoom(code, true);
});

joinBtn.addEventListener("click", ()=>{
  const v = roomInput.value.trim();
  if(!v){ showStatus("Masukkan kode ruangan atau buat baru."); return; }
  enterRoom(v, false);
});

pasteBtn.addEventListener("click", ()=>{
  // parse ?room= code from url and paste into input
  const p = new URLSearchParams(location.search).get("room");
  if(p){ roomInput.value = p; showStatus("Ditempel dari URL."); }
  else showStatus("Tidak ada parameter room di URL.");
});

function enterRoom(code, justCreated=false){
  roomCode = code;
  clientId = "u_"+window.FirebaseVC.randString(6);
  // ensure room exists
  window.FirebaseVC.ensureRoom(roomCode);

  // build share link
  const shareLink = `${location.origin}${location.pathname}?room=${encodeURIComponent(roomCode)}`;
  roomLinkA.href = shareLink;
  roomLinkA.textContent = shareLink;
  shareArea.classList.remove("hidden");

  // toggle screens
  mainScreen.classList.add("hidden");
  vcScreen.classList.remove("hidden");
  roomDisplay.textContent = roomCode;

  // start VC manager
  manager = new window.FirebaseVC.VCManager({
    roomCode,
    clientId,
    onLocalStream: (stream) => {
      localVideo.srcObject = stream;
    },
    onRemoteStream: (remoteId, stream) => {
      const id = "remote_"+remoteId;
      if(!stream){
        const el = document.getElementById(id);
        if(el) el.remove();
        return;
      }
      let box = document.getElementById(id);
      if(!box){
        box = document.createElement("div");
        box.className = "remote-box";
        box.id = id;
        const v = document.createElement("video");
        v.autoplay = true;
        v.playsInline = true;
        v.id = id+"_vid";
        v.controls = false;
        box.appendChild(v);
        remotesDiv.appendChild(box);
      }
      document.getElementById(id+"_vid").srcObject = stream;
    },
    onStatus: (s) => {
      if(s === "media-error") showStatus("Tidak dapat akses kamera/mik. Izinkan perangkat.");
      else if(s === "joined") showStatus("Berhasil masuk ruangan. Menunggu/terhubung dengan user lain.");
      else if(s.startsWith("left")) {
        showStatus("Anda keluar dari ruangan.");
        setTimeout(()=>resetToMain(), 600);
      } else if(s === "room-deleted") {
        alert("Ruangan telah dihapus oleh admin.");
        resetToMain();
      } else showStatus(s);
    }
  });

  // notify others of our join via signal (so existing peers create offer to us)
  window.FirebaseVC.postSignal(roomCode, { type: "user-joined", from: clientId, clientId: clientId });

  // if just created, show share link prominently
  if(justCreated){
    showStatus("Ruangan dibuat. Bagikan link ke teman.");
  }
}

leaveBtn.addEventListener("click", ()=>{
  if(manager) manager.closeAll("user");
  else resetToMain();
});

muteBtn.addEventListener("click", ()=>{
  muted = !muted;
  if(manager) manager.mute(muted);
  muteBtn.textContent = muted ? "Unmute" : "Mute";
});

camBtn.addEventListener("click", ()=>{
  camOff = !camOff;
  if(manager) manager.cam(camOff);
  camBtn.textContent = camOff ? "Camera On" : "Camera Off";
});

function resetToMain(){
  if(manager) {
    try{ manager.closeAll("reset"); }catch(e){}
    manager = null;
  }
  remotesDiv.innerHTML = "";
  localVideo.srcObject = null;
  roomDisplay.textContent = "";
  roomInput.value = "";
  mainScreen.classList.remove("hidden");
  vcScreen.classList.add("hidden");
  shareArea.classList.add("hidden");
  showStatus("");
}

// copy link
copyLinkBtn.addEventListener("click", async ()=>{
  const link = roomLinkA.href;
  try {
    await navigator.clipboard.writeText(link);
    alert("Link disalin ke clipboard.");
  } catch(e){
    prompt("Salin link ini:", link);
  }
});

// auto-join if ?room= in URL
(function autoJoinFromUrl(){
  const params = new URLSearchParams(location.search);
  const r = params.get("room");
  if(r){
    roomInput.value = r;
    // auto join immediately
    setTimeout(()=> joinBtn.click(), 300);
  }
})();