// webrtc.js (menggunakan Firebase Realtime DB untuk signaling & room management)
// Mengharapkan window._firebase.db tersedia (index/admin telah inisialisasi)

(function(){
  // utilities
  function randString(len = 8) {
    const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    let s = "";
    for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
    return s;
  }
  function nowISO(){ return new Date().toISOString(); }

  const db = window._firebase.db;
  const ROOMS_ROOT = "vc_rooms";
  const SIGNALS_ROOT = "signals";

  // Read/write room structure in RTDB:
  // /vc_rooms/{room} = { createdAt:..., users: { clientId: timestamp, ... } }

  function ensureRoom(roomCode){
    const ref = db.ref(`${ROOMS_ROOT}/${roomCode}`);
    // set createdAt if not exists
    ref.once("value", snap=>{
      if(!snap.exists()){
        ref.set({ createdAt: nowISO(), users: {} });
      }
    });
  }

  function addUserToRoom(roomCode, clientId){
    const userRef = db.ref(`${ROOMS_ROOT}/${roomCode}/users/${clientId}`);
    userRef.set(firebase.database.ServerValue.TIMESTAMP);
    // ensure createdAt set
    ensureRoom(roomCode);
    // setup onDisconnect remove
    userRef.onDisconnect().remove();
  }

  function removeUserFromRoom(roomCode, clientId){
    const userRef = db.ref(`${ROOMS_ROOT}/${roomCode}/users/${clientId}`);
    userRef.remove();
  }

  function deleteRoom(roomCode){
    const roomRef = db.ref(`${ROOMS_ROOT}/${roomCode}`);
    const sigRef = db.ref(`${SIGNALS_ROOT}/${roomCode}`);
    roomRef.remove();
    sigRef.remove();
    // notify via a special signal so connected clients can respond quickly
    const notifyRef = db.ref(`${SIGNALS_ROOT}/${roomCode}`);
    notifyRef.push({ type: "room-deleted", from: "admin", ts: Date.now() });
  }

  // Signaling via RTDB: push message to /signals/{room}
  function postSignal(roomCode, msg){
    msg._ts = Date.now();
    return db.ref(`${SIGNALS_ROOT}/${roomCode}`).push(msg);
  }

  // listen signals
  function onSignal(roomCode, callback){
    const ref = db.ref(`${SIGNALS_ROOT}/${roomCode}`);
    ref.on("child_added", snap => {
      const msg = snap.val();
      // attach key so consumer may remove if needed
      msg._key = snap.key;
      callback(msg);
    });
  }

  // remove single signal node (optional)
  function removeSignal(roomCode, key){
    if(!key) return;
    db.ref(`${SIGNALS_ROOT}/${roomCode}/${key}`).remove().catch(()=>{});
  }

  // helper: listen for room deletion
  function onRoomRemoved(roomCode, callback){
    db.ref(`${ROOMS_ROOT}/${roomCode}`).on("value", snap=>{
      if(!snap.exists()){
        callback();
      }
    });
  }

  // export functions
  window.FirebaseVC = {
    randString, ensureRoom, addUserToRoom, removeUserFromRoom, deleteRoom,
    postSignal, onSignal, removeSignal, onRoomRemoved, db
  };

  // VC Manager (WebRTC)
  class VCManager {
    constructor({roomCode, clientId, onLocalStream, onRemoteStream, onStatus}) {
      this.room = roomCode;
      this.clientId = clientId;
      this.onLocalStream = onLocalStream;
      this.onRemoteStream = onRemoteStream;
      this.onStatus = onStatus || (()=>{});
      this.pcMap = {}; // remoteId => RTCPeerConnection
      this.stream = null;
      this.configuration = { iceServers: [{urls: "stun:stun.l.google.com:19302"}] };
      this._listening = false;
      this._init();
    }

    async _init(){
      try {
        this.stream = await navigator.mediaDevices.getUserMedia({video:true,audio:true});
        if(this.onLocalStream) this.onLocalStream(this.stream);
        // join room in RTDB
        window.FirebaseVC.ensureRoom(this.room);
        window.FirebaseVC.addUserToRoom(this.room, this.clientId);

        // listen for signals
        this._listenSignals();

        // listen room removed
        window.FirebaseVC.onRoomRemoved(this.room, ()=>{
          this.onStatus("room-deleted");
          this.closeAll("room-deleted");
        });

        this.onStatus("joined");
      } catch(e){
        console.error("getUserMedia error", e);
        this.onStatus("media-error");
      }
    }

    _listenSignals(){
      if(this._listening) return;
      this._listening = true;
      window.FirebaseVC.onSignal(this.room, async (msg) => {
        if(!msg) return;
        // ignore messages from self except some types
        if(msg.from === this.clientId) return;

        switch(msg.type){
          case "user-joined":
            // existing user should create offer to the new user
            if(msg.clientId && msg.clientId !== this.clientId){
              await this._createOfferTo(msg.clientId);
            }
            break;
          case "offer":
            if(msg.to !== this.clientId) return;
            await this._handleOffer(msg.offer, msg.from, msg._key);
            break;
          case "answer":
            if(msg.to !== this.clientId) return;
            if(this.pcMap[msg.from]){
              await this.pcMap[msg.from].setRemoteDescription(new RTCSessionDescription(msg.answer));
            }
            break;
          case "candidate":
            if(msg.to !== this.clientId) return;
            if(this.pcMap[msg.from]){
              try{ await this.pcMap[msg.from].addIceCandidate(new RTCIceCandidate(msg.candidate)); }
              catch(e){ console.warn("addIce failed", e); }
            }
            break;
          case "room-deleted":
            // admin deleted room
            this.onStatus("room-deleted");
            this.closeAll("room-deleted");
            break;
        }
        // remove processed signaling message to keep DB clean (optional)
        if(msg._key && msg.type !== "room-deleted"){
          // be safe: remove only if older than 1s (to avoid race)
          setTimeout(()=> window.FirebaseVC.removeSignal(this.room, msg._key), 1500);
        }
      });

      // Also monitor users list: when new user appears, current will be notified via 'user-joined' message from the joiner
      const usersRef = window.FirebaseVC.db.ref(`vc_rooms/${this.room}/users`);
      usersRef.on("child_removed", (snap)=>{
        // someone left, close peer if exists
        const remoteId = snap.key;
        this._closePeer(remoteId);
      });
    }

    async _createPeer(remoteId){
      if(this.pcMap[remoteId]) return this.pcMap[remoteId];
      const pc = new RTCPeerConnection(this.configuration);
      this.pcMap[remoteId] = pc;

      // add local tracks
      if(this.stream){
        for(const t of this.stream.getTracks()) pc.addTrack(t, this.stream);
      }

      // ontrack -> remote stream
      const remoteStream = new MediaStream();
      pc.ontrack = (ev)=> {
        ev.streams[0].getTracks().forEach(t => remoteStream.addTrack(t));
        if(this.onRemoteStream) this.onRemoteStream(remoteId, remoteStream);
      };

      // ICE candidate
      pc.onicecandidate = (ev)=>{
        if(ev.candidate){
          window.FirebaseVC.postSignal(this.room, { type: "candidate", from:this.clientId, to: remoteId, candidate: ev.candidate });
        }
      };

      pc.onconnectionstatechange = ()=> {
        if(pc.connectionState === "disconnected" || pc.connectionState === "failed" || pc.connectionState === "closed"){
          this._closePeer(remoteId);
        }
      };

      return pc;
    }

    async _createOfferTo(remoteId){
      const pc = await this._createPeer(remoteId);
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      window.FirebaseVC.postSignal(this.room, { type: "offer", from:this.clientId, to: remoteId, offer: pc.localDescription });
    }

    async _handleOffer(offer, fromId, key){
      const pc = await this._createPeer(fromId);
      await pc.setRemoteDescription(new RTCSessionDescription(offer));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      window.FirebaseVC.postSignal(this.room, { type: "answer", from:this.clientId, to: fromId, answer: pc.localDescription });
      // optionally remove the offer msg
      if(key) setTimeout(()=> window.FirebaseVC.removeSignal(this.room, key), 1500);
    }

    _closePeer(remoteId){
      const pc = this.pcMap[remoteId];
      if(pc){
        try{ pc.close(); }catch(e){}
        delete this.pcMap[remoteId];
        if(this.onRemoteStream) this.onRemoteStream(remoteId, null);
      }
    }

    closeAll(reason){
      // remove self from room, stop tracks, close peers
      window.FirebaseVC.removeUserFromRoom ? window.FirebaseVC.removeUserFromRoom(this.room, this.clientId) : window.FirebaseVC.removeUserFromRoom(this.room, this.clientId);
      const usersRef = window.FirebaseVC.db.ref(`vc_rooms/${this.room}/users/${this.clientId}`);
      // attempt explicit removal
      usersRef.remove().catch(()=>{});
      for(const k of Object.keys(this.pcMap)) this._closePeer(k);
      if(this.stream){
        for(const t of this.stream.getTracks()) t.stop();
        this.stream = null;
      }
      this.onStatus("left:"+String(reason||"user"));
    }

    mute(m){
      if(!this.stream) return;
      this.stream.getAudioTracks().forEach(t=>t.enabled = !m);
    }

    cam(off){
      if(!this.stream) return;
      this.stream.getVideoTracks().forEach(t=>t.enabled = !off);
    }
  }

  window.FirebaseVC.VCManager = VCManager;

})();