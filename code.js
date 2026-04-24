// ============================================================
// WARIN.SPACE HACK MOD v2 - github.com/yourrepo/warin-hack
// ORIGINAL FEATURES:
//   faster fire | HP numbers | zoom | enemy radar |
//   auto-fire | ship tracers | auto scrap | range ring
// NEW FEATURES:
//   auto-aim | off-screen ESP arrows |
//   movement prediction lines | threat meter | FPS counter |
//   enemy distance labels
// ----------------------------------------------------------
// TOGGLE KEYS:
//   [  = AutoFire    ]  = Tracers    \  = AutoScrap
//   T = AutoAim   H = ESPArrows  N = PredictLine
//   Z = FPS       D = EnemyDist
//   Scroll wheel = zoom in/out
// ============================================================
var hackFireRate    = 80;    // ms between shots (vanilla=100, lower=faster)
var hackZoom        = 1.0;   // zoom multiplier (1=normal, >1=zoom in, <1=zoom out)
var hackAutoFire    = false; // auto-fire at nearest enemy in range
var hackTracers     = true;  // draw direction lines on all ships
var hackAutoScrap   = false; // auto-steer toward nearest scrap
var hackHPNumbers   = true;  // show HP as numbers on health bars
var hackEnemyRadar  = true;  // show all players (incl. enemies) on minimap
var hackRangeRing   = true;  // show your firing range as a circle
// --- new hacks v2 ---
var hackAutoAim     = false; // snap selfAngle toward nearest enemy (pairs great with AutoFire)
var hackESPArrows   = true;  // off-screen enemy arrows drawn at viewport edge
var hackPredictLine = false; // dashed movement-prediction line + dot on every ship
var hackThreatMeter = true;  // show # enemies within ~1.5x firing range (colored by danger)
var hackFPS         = true;  // FPS counter top-left corner
var hackEnemyDist   = false; // distance (world units) printed next to each player name
// internal tracking state
var hackVelocities  = {};    // {id: {vx, vy}}  used by LeadAim & PredictLine
var hackLastPos     = {};    // {id: {x, y, t}}
var hackFPSValue    = 0, hackFPSFrames = 0, hackFPSTimer = Date.now();

// ============================================================
// ============================================================
// WARIN.SPACE AUTO-PLAYER BOT  v2
// ============================================================
// States: SCRAP | ENGAGE | RETREAT
//   SCRAP   — collect best-scored nearby scrap, roam if none
//   ENGAGE  — orbit enemy, lead-aim, fire; chase if out of range
//   RETREAT — sprint to base; committed minimum 3s; won't
//             exit until HP recovers AND area is clear
//
// Toggle: [B] key  |  HUD shows BOT:STATE
// ============================================================

var botEnabled   = false;
var botState     = "SCRAP";
var botStateAt   = 0;        // timestamp we entered current state
var botAimAng    = 0;        // smoothed aim angle
var botOrbitDir  = 1;
var botOrbitFlip = 0;        // timestamp of last orbit flip
var botLastAbi   = 0;
var botUpgTimer  = 0;
var botScrapKey  = null;     // locked scrap target
var botScrapAge  = 0;        // when we locked it

// --- tuning ---
var BOT_HZ           = 80;    // tick ms
var BOT_ENTER_ENGAGE = 1.4;   // enter ENGAGE when enemy within this * firingRange
var BOT_EXIT_ENGAGE  = 2.0;   // exit  ENGAGE when enemy beyond this * firingRange
var BOT_ENTER_FLEE   = 0.26;  // enter RETREAT below this HP fraction
var BOT_EXIT_FLEE    = 0.62;  // exit  RETREAT above this HP fraction (+ safe)
var BOT_MIN_FLEE     = 3000;  // minimum ms to stay in RETREAT
var BOT_ORBIT_FRAC   = 0.80;  // orbit at this fraction of firingRange
var BOT_ORBIT_BAND   = 0.14;  // ± dead-band around orbit radius before moving
var botTick_last     = 0;

// B key
window.addEventListener("keydown", function(ev) {
  if (66 === ev.keyCode) {
    botEnabled = !botEnabled;
    botState = "SCRAP"; botStateAt = Date.now();
    console.log("Bot:", botEnabled ? "ON" : "OFF");
  }
}, false);

// ── Pure helpers ─────────────────────────────────────────────
function _bd2(ax, ay, bx, by) { var dx=ax-bx,dy=ay-by; return dx*dx+dy*dy; }
function _bd (ax, ay, bx, by) { return Math.sqrt(_bd2(ax,ay,bx,by)); }
function _ba (tx, ty)         { return Math.atan2(ty-playerY, tx-playerX); }

function _isEnemy(p) {
  return p && p.i > 0 && (FFA || p.c !== selfTeam);
}

// Smoothly interpolate angle (shortest path, 25% per call)
function _lerpAng(cur, tgt, t) {
  var d = tgt - cur;
  while (d >  Math.PI) d -= 2*Math.PI;
  while (d < -Math.PI) d += 2*Math.PI;
  return cur + d * t;
}

// Set movement direction WITHOUT touching selfAngle
function _moveDir(ang) {
  pc = window.innerWidth  / 2 + Math.cos(ang) * 350;
  qc = window.innerHeight / 2 + Math.sin(ang) * 350;
}
function _stop() {
  pc = window.innerWidth  / 2;
  qc = window.innerHeight / 2;
}

// ── World queries ─────────────────────────────────────────────

function botNearestEnemy() {
  var best = null, bd2 = Infinity;
  for (var id in players) {
    var p = players[id];
    if (!_isEnemy(p)) continue;
    var d2 = _bd2(playerX, playerY, p.a, p.b);
    if (d2 < bd2) { bd2 = d2; best = { id:id, p:p, d2:d2 }; }
  }
  return best;
}

// Score scraps: high = desirable.
// Penalty: enemies near the scrap path/destination drag the score down.
function botBestScrap() {
  // Build enemy list once
  var enemies = [];
  for (var eid in players) {
    var ep = players[eid];
    if (_isEnemy(ep)) enemies.push(ep);
  }
  var dangerR  = selfFiringRange * 1.6;   // enemies within this hurt the score
  var dangerR2 = dangerR * dangerR;

  var bestKey = null, bestScore = -Infinity;
  for (var k in scraps) {
    var s = scraps[k];
    var toScrap = _bd(playerX, playerY, s.x, s.y);
    // base score: inverse distance (prefer closer)
    var score = 5000 - toScrap;
    // mid-point of path to scrap
    var mx = (playerX + s.x) / 2, my = (playerY + s.y) / 2;
    for (var ei = 0; ei < enemies.length; ei++) {
      var e = enemies[ei];
      // Penalty proportional to how close enemy is to scrap destination
      var d2dest = _bd2(e.a, e.b, s.x, s.y);
      if (d2dest < dangerR2) score -= (1 - d2dest / dangerR2) * 3000;
      // Penalty for enemy being near the midpoint of our path
      var d2path = _bd2(e.a, e.b, mx, my);
      if (d2path < dangerR2) score -= (1 - d2path / dangerR2) * 1500;
    }
    if (score > bestScore) { bestScore = score; bestKey = k; }
  }
  return bestKey ? { key:bestKey, s:scraps[bestKey], score:bestScore } : null;
}

// Is the area around (x,y) safe (no living enemy within radius)?
function botAreaSafe(x, y, radius) {
  var r2 = radius * radius;
  for (var id in players) {
    var p = players[id];
    if (_isEnemy(p) && _bd2(x, y, p.a, p.b) < r2) return false;
  }
  return true;
}

// ── Passive systems (run every tick regardless of state) ──────

function _tryUpgrade() {
  var now = Date.now();
  if (now - botUpgTimer < 300) return;   // max one upgrade per 300ms
  for (var slot = 0; slot < 4; slot++) {
    var cost = Jb(slot);
    if (cost != null && scrap >= cost) { kd(slot); botUpgTimer = now; return; }
  }
}

function _tryAbility(enemy) {
  var now = Date.now();
  if (now - botLastAbi < 1500) return;
  if (!enemy) return;
  var r = selfFiringRange * 1.4;
  if (enemy.d2 < r * r) { Gf(0); botLastAbi = now; }
}

function _doAim(tx, ty) {
  // Lead-aim if we have velocity data
  var ltx = tx, lty = ty;
  // find id by matching position to enemy — reuse what caller passes
  botAimAng = _lerpAng(botAimAng, Math.atan2(lty - playerY, ltx - playerX), 0.30);
  selfAngle = botAimAng;
}

function _doAimLeading(enemy) {
  var tx = enemy.p.a, ty = enemy.p.b;
  if (hackVelocities[enemy.id]) {
    var leadT = Math.sqrt(enemy.d2) / 840;
    tx += hackVelocities[enemy.id].vx * leadT;
    ty += hackVelocities[enemy.id].vy * leadT;
  }
  botAimAng = _lerpAng(botAimAng, Math.atan2(ty - playerY, tx - playerX), 0.28);
  selfAngle = botAimAng;
}

// ── State change (with guard) ─────────────────────────────────
function _setState(s) {
  if (botState === s) return;
  botState = s;
  botStateAt = Date.now();
  botScrapKey = null;   // clear locked scrap on any state change
}

// ── Orbit helper (decoupled aim / move) ──────────────────────
function _orbitEnemy(ep) {
  var desiredR = selfFiringRange * BOT_ORBIT_FRAC;
  var dist     = _bd(playerX, playerY, ep.a, ep.b);
  var toEnemy  = _ba(ep.a, ep.b);
  var now      = Date.now();

  // Flip orbit direction every 4–5 seconds or when hugging world edge
  var margin = 250;
  var nearWall = playerX < margin || playerX > td - margin ||
                 playerY < margin || playerY > ud - margin;
  if (nearWall || now - botOrbitFlip > 4200 + Math.random()*800) {
    botOrbitDir *= -1;
    botOrbitFlip = now;
  }

  var lo = desiredR * (1 - BOT_ORBIT_BAND);
  var hi = desiredR * (1 + BOT_ORBIT_BAND);

  var moveAng;
  if (dist > hi) {
    // Close in — blend toward enemy with a slight orbital lean
    moveAng = toEnemy + botOrbitDir * 0.25;
  } else if (dist < lo) {
    // Too close — back off
    moveAng = toEnemy + Math.PI + botOrbitDir * 0.25;
  } else {
    // Sweet spot — pure orbit
    moveAng = toEnemy + (Math.PI / 2) * botOrbitDir;
  }
  _moveDir(moveAng);
}

// ── Main tick ─────────────────────────────────────────────────
function botTick() {
  if (!botEnabled) return;
  if (!vd || gc || Gc || selfHealth <= 0) return;

  var now = Date.now();
  if (now - botTick_last < BOT_HZ) return;
  botTick_last = now;

  _tryUpgrade();

  var hpFrac  = selfHealth / selfMaxHealth;
  var enemy   = botNearestEnemy();
  var enemyD  = enemy ? Math.sqrt(enemy.d2) : Infinity;
  var engageR = selfFiringRange * BOT_ENTER_ENGAGE;
  var exitR   = selfFiringRange * BOT_EXIT_ENGAGE;
  var inRange = enemy && enemyD < selfFiringRange;

  _tryAbility(enemy);

  // ── Transition logic (hysteresis — separate enter/exit thresholds) ────────

  if (botState !== "RETREAT") {
    // Enter RETREAT: hard threshold, preempts everything
    if (hpFrac < BOT_ENTER_FLEE) {
      _setState("RETREAT");
    }
    // Enter/stay ENGAGE
    else if (enemy && enemyD < engageR) {
      _setState("ENGAGE");
    }
    // Exit ENGAGE only when enemy is far enough away
    else if (botState === "ENGAGE" && enemyD > exitR) {
      _setState("SCRAP");
    }
    // Default
    else if (botState !== "ENGAGE") {
      _setState("SCRAP");
    }
  } else {
    // Exit RETREAT: must have recovered HP, area must be safe, min time elapsed
    var timeInFlee = now - botStateAt;
    var safeRadius = selfFiringRange * 1.8;
    var safe       = botAreaSafe(playerX, playerY, safeRadius);
    if (hpFrac >= BOT_EXIT_FLEE && safe && timeInFlee >= BOT_MIN_FLEE) {
      _setState(enemy ? "ENGAGE" : "SCRAP");
    }
  }

  // ── Actions ──────────────────────────────────────────────────────────────

  switch (botState) {

    case "RETREAT": {
      var base = bb(selfTeam);
      _moveDir(_ba(base[0], base[1]));
      // While fleeing, face away to discourage pursuit
      // but still fire if something is literally in our crosshair
      var awayAng = _ba(base[0], base[1]);
      botAimAng   = _lerpAng(botAimAng, awayAng, 0.15);
      selfAngle   = botAimAng;
      // Opportunistic return fire if enemy is in range while we run
      if (inRange && enemy) {
        _doAimLeading(enemy);
        Ec = true;
      }
      break;
    }

    case "ENGAGE": {
      if (!enemy) { _setState("SCRAP"); break; }
      // Always aim with lead compensation
      _doAimLeading(enemy);
      // Fire if in range
      if (inRange) Ec = true;
      // Movement: orbit if in range, charge if out
      if (enemyD < selfFiringRange * 1.1) {
        _orbitEnemy(enemy.p);
      } else {
        // Chase — move straight toward
        _moveDir(_ba(enemy.p.a, enemy.p.b));
      }
      break;
    }

    case "SCRAP": {
      // Re-evaluate target every 1.2s or if current target gone
      if (!botScrapKey || !scraps[botScrapKey] || now - botScrapAge > 1200) {
        var best = botBestScrap();
        botScrapKey = best ? best.key : null;
        botScrapAge = now;
      }
      if (botScrapKey && scraps[botScrapKey]) {
        var sv = scraps[botScrapKey];
        // Steer around nearby enemies on the way to scrap
        var toScrapAng = _ba(sv.x, sv.y);
        // Repulsion from nearest enemy — push movement angle away from them
        if (enemy && enemyD < selfFiringRange * 2.0) {
          var awayFromEnemy = _ba(enemy.p.a, enemy.p.b) + Math.PI;
          var pushStrength  = Math.max(0, 1 - enemyD / (selfFiringRange * 2.0));
          // Blend movement angle: mostly toward scrap, slightly away from enemy
          var blendX = Math.cos(toScrapAng) + Math.cos(awayFromEnemy) * pushStrength * 0.6;
          var blendY = Math.sin(toScrapAng) + Math.sin(awayFromEnemy) * pushStrength * 0.6;
          toScrapAng = Math.atan2(blendY, blendX);
        }
        _moveDir(toScrapAng);
        // Aim toward nearest enemy while scooping (shoot if close enough)
        if (enemy) {
          _doAimLeading(enemy);
          if (inRange) Ec = true;
        } else {
          botAimAng = _lerpAng(botAimAng, toScrapAng, 0.1);
          selfAngle = botAimAng;
        }
      } else {
        // No scrap: patrol toward enemy base, steering around enemies
        var eb      = bb(1 - selfTeam);
        var patAng  = _ba(eb[0], eb[1]);
        if (enemy && enemyD < selfFiringRange * 1.8) {
          // Don't walk into them blind — stay on SCRAP until ENGAGE catches it
          var awayX = Math.cos(patAng) + Math.cos(_ba(enemy.p.a,enemy.p.b)+Math.PI)*0.5;
          var awayY = Math.sin(patAng) + Math.sin(_ba(enemy.p.a,enemy.p.b)+Math.PI)*0.5;
          patAng = Math.atan2(awayY, awayX);
        }
        _moveDir(patAng);
        botAimAng = _lerpAng(botAimAng, patAng, 0.08);
        selfAngle = botAimAng;
      }
      break;
    }
  }
}

// ── Patch Uf() ────────────────────────────────────────────────
var _botOrigUf = null;
(function _patchUf() {
  if (typeof Uf === 'undefined') { setTimeout(_patchUf, 100); return; }
  _botOrigUf = Uf;
  Uf = function() { _botOrigUf.apply(this, arguments); botTick(); };
})();

// Keyboard toggles
window.addEventListener("keydown", function(ev) {
  if (219 == ev.keyCode) { hackAutoFire    = !hackAutoFire;    console.log("AutoFire:",    hackAutoFire);    }  // [
  if (221 == ev.keyCode) { hackTracers     = !hackTracers;     console.log("Tracers:",     hackTracers);     }  // ]
  if (220 == ev.keyCode) { hackAutoScrap   = !hackAutoScrap;   console.log("AutoScrap:",   hackAutoScrap);   }  // backslash
  if ( 84 == ev.keyCode) { hackAutoAim     = !hackAutoAim;     console.log("AutoAim:",     hackAutoAim);     }  // T
  if ( 72 == ev.keyCode) { hackESPArrows   = !hackESPArrows;   console.log("ESPArrows:",   hackESPArrows);   }  // H
  if ( 78 == ev.keyCode) { hackPredictLine = !hackPredictLine; console.log("PredictLine:", hackPredictLine); }  // N
  if ( 90 == ev.keyCode) { hackFPS         = !hackFPS;         console.log("FPS:",         hackFPS);         }  // Z
  if ( 68 == ev.keyCode) { hackEnemyDist   = !hackEnemyDist;   console.log("EnemyDist:",   hackEnemyDist);   }  // D
}, false);
// Scroll-wheel zoom
window.addEventListener("wheel", function(ev) {
  ev.preventDefault();
  hackZoom = Math.min(Math.max(hackZoom - ev.deltaY * 0.001, 0.3), 3.5);
  Ke();
}, { passive: false });
// ============================================================
var c = document.getElementById("canvas"),
k = c.getContext("2d");
k.aa = !0;
k.$ = !0;
k.Z = !0;
var aa = document.getElementById("canvasBackground"),
ba = aa.getContext("2d"),
ca = document.getElementById("canvasTrail"),
da = ca.getContext("2d"),
ea = document.getElementById("canvasTrailflip"),
fa = ea.getContext("2d"),
l = document.createElement("canvas"),
n = l.getContext("2d"),
ga = document.getElementById("content"),
ha = document.getElementById("playButton"),
ia = document.getElementById("selectWorld"),
ja = document.getElementById("pregame"),
ka = document.getElementById("connecting"),
la = document.getElementById("passwordIncorrect"),
ma = document.getElementById("usernameEmailInUse"),
na = document.getElementById("ircConnect"),
p = document.getElementById("ServerSelectionCombo");
p.onchange = function() {
  chosenServer = p.childNodes[p.selectedIndex].value;
  qa()
};
for (var ra = document.getElementById("miniclipLogo"), sa = document.getElementById("SSBack"), ta = document.getElementById("serverSelection"), ua = document.getElementById("serverIdText"), wa = document.getElementById("regionIdText"), p = document.getElementById("ServerSelectionCombo"), xa = document.getElementById("loginScreen"), ya = document.getElementById("registerScreen"), za = document.getElementById("loggedInShown"), Aa = document.getElementById("MusicIDTextUnder"), Ba = document.getElementById("MusicSelection"), Ca = [], t = 0; 20 > t; t++) Ca[t] = document.getElementById("SSI" + t),
Ca[t].src = "serverIndicators/0.png";
function Da() {
  Ea = document.getElementById("loginUsernameField").value;
  var a = document.getElementById("loginPasswordField").value;
  document.getElementById("loginPasswordField").value = "";
  null == Ea || 0 == Ea.length ? Ea = localStorage.username: document.getElementById("NameArea").value = Ea;
  Fa = a;
  if (null != u && !x) {
    var a = new ArrayBuffer(2 + 2 * Ea.length),
    b = new DataView(a);
    b.setUint8(0, 15);
    Ga(b, 1, Ea);
    u.send(a);
    localStorage.username = Ea
  }
  return ! 1
}
document.getElementById("loginButton").onclick = Da;
function Ha(a, b) {
  var e;
  Fa ? (e = CryptoJS.SHA512(Fa + a).toString(), localStorage.hash = e) : e = localStorage.hash;
  Fa = null;
  e = CryptoJS.SHA512(e + b).toString();
  if (null != u && !x) {
    var d = new ArrayBuffer(129),
    f = new DataView(d);
    f.setUint8(0, 16);
    for (var g = 0; 128 > g; g++) f.setUint8(g + 1, e.charCodeAt(g));
    u.send(d)
  }
}
document.getElementById("registerButton").onclick = function(a, b) {
  a = document.getElementById("registerUsernameField").value;
  var e = document.getElementById("registerEmailField").value;
  b = document.getElementById("registerPasswordField").value;
  if (b != document.getElementById("registerConfirmPasswordField").value) console.log("Passwords don't match");
  else if (Ea = a, Fa = b, null != u && !x) {
    var d = new ArrayBuffer(4 + 2 * Ea.length + 2 * e.length + 2 * Ia.length),
    f = new DataView(d);
    f.setUint8(0, 17);
    Ga(f, 1, Ea);
    Ga(f, 2 + 2 * Ea.length, e);
    Ga(f, 3 + 2 * Ea.length + 2 * e.length, Ia);
    u.send(d)
  }
};
function Ja(a) {
  a = CryptoJS.SHA512(Fa + a).toString();
  Fa = null;
  if (null != u && !x) {
    var b = new ArrayBuffer(129),
    e = new DataView(b);
    e.setUint8(0, 18);
    for (var d = 0; 128 > d; d++) e.setUint8(d + 1, a.charCodeAt(d));
    u.send(b)
  }
}
function Ka() {
  xa.style.visibility = "hidden";
  ya.style.visibility = "hidden"
}
function La(a) {
  ga.style.display = a ? "": "none"
}
document.getElementById("frontScreenLoginBtn").onclick = function() {
  Ka();
  document.getElementById("loginScreen").style.visibility = "visible"
};
document.getElementById("frontScreenRegisterBtn").onclick = function() {
  Ka();
  document.getElementById("registerScreen").style.visibility = "visible"
};
document.getElementById("frontScreenLogoutBtn").onclick = function() {
  if (null != u && x) {
    var a = new ArrayBuffer(1); (new DataView(a)).setUint8(0, 20);
    u.send(a);
    localStorage.hash = null
  }
};
document.getElementById("redeemCodeAcceptButton").onclick = function() {
  var a = document.getElementById("redeemCodeField").value;
  if (null != u && x) {
    var b = new ArrayBuffer(2 + 2 * a.length),
    e = new DataView(b);
    e.setUint8(0, 19);
    Ga(e, 1, a);
    u.send(b)
  }
  document.getElementById("redeemCodeField").value = "";
  document.getElementById("redeemCodeWindow").style.visibility = "hidden"
};
for (t = 0; 20 > t; t++)(function(a) {
  document.getElementById("SS" + a).addEventListener("click",
  function() {
    if (null != u && u.readyState == u.OPEN) {
      var b = new ArrayBuffer(2),
      e = new DataView(b);
      e.setUint8(0, 12);
      e.setUint8(1, a);
      u.send(b)
    }
    Ma()
  })
})(t);
function Ma() {
  ta.style.visibility = "hidden";
  ja.style.visibility = "visible"
}
ia.addEventListener("click",
function() {
  for (var a = 0; 20 > a; a++) Ca[a].src = "serverIndicators/0.png";
  null != u && u.readyState == u.OPEN && (a = new ArrayBuffer(1), (new DataView(a)).setUint8(0, 13), u.send(a));
  Ma();
  ta.style.visibility = "visible";
  ja.style.visibility = "hidden"
});
sa.addEventListener("click", Ma);
IsMobile || (document.getElementById("OptionBackground0").onclick = function() {
  Na.src = "bluebackground.png"
},
document.getElementById("OptionBackground1").onclick = function() {
  Na.src = "bluebackgroundOld.png"
},
document.getElementById("OptionController0").onclick = function() {
  Oa = !0
},
document.getElementById("OptionController1").onclick = function() {
  Oa = !1
},
soundOn = localStorage.soundOn || "1", updateSoundButton = function() {
  document.getElementById("SoundBtnImg").src = "1" == soundOn ? "audioOn.png": "audioOff.png"
},
updateSoundButton(), toggleSound = function() {
  soundOn = "1" == soundOn ? "0": "1";
  updateSoundButton();
  localStorage.soundOn = soundOn
});
function Pa(a, b, e, d, f, g, h, v, m, q) {
  this.x = a;
  this.y = b;
  this.angle = e;
  this.a = a;
  this.b = b;
  this.f = e;
  this.i = f;
  this.u = d;
  this.c = g;
  this.name = m;
  this.s = h;
  this.h = v;
  Qa(m);
  this.l = 20;
  this.m = q
}
function Ra(a) {
  a.f > a.angle + y && (a.f -= 2 * y);
  a.f < a.angle - y && (a.f += 2 * y);
  a.f = (25 * a.f + a.angle) / 26;
  a.a = (24 * a.a + a.x) / 25;
  a.b = (24 * a.b + a.y) / 25
}
function Sa(a, b, e, d) {
  for (var s in a.s) Ta[s](k, b, e, d)
}
function Ua(a, b, e, d, f, g) {
  this.id = a;
  this.name = b;
  this.h = e;
  this.G = d;
  this.V = f;
  this.type = g
}
function Va(a, b) {
  this.x = a;
  this.y = b;
  this.angle = 2 * Math.random() * y;
  this.X = z(0, 3)
}
Va.prototype.g = function(a, b) {
  A(k, Wa[this.X], this.angle, this.x - a, this.y - b, 40, 40)
};
function Xa(a, b, e, d, f, g) {
  this.a = a;
  this.b = b;
  this.i = e;
  this.u = d;
  this.type = f;
  this.c = g;
  this.angle = 2 * Math.random() * y;
  this.l = 30
}
Xa.prototype.g = function(a, b) {
  if (3 == this.type) Ta[1](k, this.a - a, this.b - b);
  A(k, turretImages[this.c][this.type], this.angle + y / 2, this.a - a, this.b - b, 100, 100);
  Ya(this.a - a, this.b - b - 70, this.i / this.u, 1, this.u)
};
Xa.prototype.H = function() {
  for (var a = 0; a < z(4, 8); a++) Za(this.a, this.b, z(0, 100), z(500, 900), z(35, 45), 55);
  $a("destruction", .2)
};
function ab(a) {
  this.b = this.a = 0;
  this.c = a;
  this.l = 250
}
ab.prototype.update = function() {
  var a = bb(this.c);
  this.a = a[0];
  this.b = a[1]
};
function cb(a, b) {
  this.I = a;
  this.type = b;
  this.j = db(0, 26 * y);
  this.f = this.angle = 0;
  this.D = eb(this);
  this.b = this.a = 0;
  this.l = 22;
  this.C = 0 == z(0, 1);
  this.O = this.N = 1
}
function eb(a) {
  return [Math.sin(a.j / 3) * Math.cos(a.j / 7) * 130, Math.cos(a.j / 13) * Math.sin(a.j / 5) * 130]
}
cb.prototype.g = function(a, b) {
  var e, d, f;
  if (selfID != this.I) {
    f = players[this.I];
    if (null == f) return;
    e = f.a;
    d = f.b;
    f = f.c
  } else e = playerX,
  d = playerY,
  f = selfTeam;
  var g = this.D;
  this.j += .07;
  this.D = eb(this);
  this.angle = Math.atan2(this.D[1] - g[1], this.D[0] - g[0]);
  this.a = e + g[0];
  this.b = d + g[1];
  this.f > this.angle + y && (this.f -= 2 * y);
  this.f < this.angle - y && (this.f += 2 * y);
  this.f = (20 * this.f + this.angle) / 21;
  e = fb(Math.sin(this.j / 3) - Math.sin((this.j - .07) / 3));
  d = fb(Math.cos(this.j / 13) - Math.cos((this.j - .07) / 13));
  if (e != this.N || d != this.O) this.C = !this.C;
  this.N = e;
  this.O = d;
  A(k, droneImages[f][this.type], this.f + y / 2, this.a - a, this.b - b, 45, 45)
};
cb.prototype.H = function() {
  if (4 != this.type) {
    for (var a = 0; a < z(2, 5); a++) Za(this.a, this.b, z(0, 100), z(500, 900), z(20, 35), 20);
    $a("destruction", .2)
  }
};
function gb(a, b) {
  this.x = a;
  this.y = b;
  this.a = a;
  this.b = b;
  this.c = 2;
  this.l = 250
}
gb.prototype.g = function(a, b) {
  this.a = (24 * this.a + this.x) / 25;
  this.b = (24 * this.b + this.y) / 25;
  A(k, hb, 0, this.a - a, this.b - b, 500, 500)
};
function ib(a, b, e, d) {
  this.x = a;
  this.y = b;
  this.a = a;
  this.b = b;
  this.type = d;
  this.c = 2;
  this.i = e;
  this.l = 50
}
ib.prototype.g = function(a, b) {
  A(k, jb, 0, this.a - a, this.b - b, 500, 500);
  k.lineWidth = 2;
  k.strokeStyle = "#DDD";
  var e = this.a - a,
  d = this.b - b;
  k.beginPath();
  k.arc(e, d, 500, 0, 2 * Math.PI);
  k.stroke()
};
var kb = "TL T TR L C R BL B BR".split(" ");
function lb(a) {
  this.images = [];
  for (var b in kb) this.images[b] = new Image,
  this.images[b].src = "frames/" + a + "/" + kb[b] + ".png"
}
lb.prototype.g = function(a, b, e, d) {
  19 > d || 19 > e || (k.drawImage(this.images[0], a, b, 11, 11), k.drawImage(this.images[1], a + 10, b, e - 19, 11), k.drawImage(this.images[2], a + e - 10, b, 10, 11), k.drawImage(this.images[3], a, b + 10, 11, d - 19), k.drawImage(this.images[4], a + 10, b + 10, e - 19, d - 19), k.drawImage(this.images[5], a + e - 10, b + 10, 10, d - 19), k.drawImage(this.images[6], a, b + d - 10, 11, 10), k.drawImage(this.images[7], a + 10, b + d - 10, e - 19, 10), k.drawImage(this.images[8], a + e - 10, b + d - 10, 10, 10))
};
function mb(a, b) {
  this.action = a;
  this.L = b;
  this.visible = !0
}
mb.prototype.g = function(a, b, e, d, f) {
  this.visible && (this.x = a, this.y = b, this.Y = e, this.U = d, this.text = f, drawButton(a, b, e, d, f, this.L))
};
function nb(a) {
  return a.visible && mouseOverArea(a.x, a.y, a.Y, a.U, a.L)
}
function ob(a, b, e) {
  this.W = a;
  this.c = b;
  this.P = e;
  null == pb[a] && Qa(a)
}
var Ta = [function(a, b, e, d) {
  a = 75 * d;
  k.globalAlpha = .1;
  k.strokeStyle = "#4dd2ff";
  k.lineWidth = 7;
  k.beginPath();
  k.arc(b, e, a, 0, 2 * Math.PI);
  k.stroke();
  k.globalAlpha = .5;
  k.strokeStyle = "#4dd2ff";
  k.lineWidth = 5;
  k.beginPath();
  k.arc(b, e, a, 0, 2 * Math.PI);
  k.stroke();
  k.globalAlpha = 1;
  k.strokeStyle = "#4dd2ff";
  k.lineWidth = 3;
  k.beginPath();
  k.arc(b, e, a, 0, 2 * Math.PI);
  k.stroke();
  k.lineWidth = 1
},
function(a, b, e) {
  k.globalAlpha = .2;
  k.lineWidth = 2;
  k.strokeStyle = "#66FF88";
  k.beginPath();
  k.arc(b, e, 300, 0, 2 * Math.PI);
  k.stroke();
  k.globalAlpha = 1
},
function() {},
function(a, b, e) {
  k.globalAlpha = .25;
  k.lineWidth = 2;
  k.strokeStyle = "#EEEE22";
  k.beginPath();
  k.arc(b, e, 300, 0, 2 * Math.PI);
  k.stroke();
  k.globalAlpha = 1
}];
Ta[255] = function(a, b, e, d) {
  a = Date.now();
  k.lineWidth = 2;
  k.globalAlpha = .5;
  for (var f = 0; 4 > f; f++) {
    var g = a / 300;
    k.strokeStyle = "rgb(" + Math.floor(255 * Math.max(Math.sin(g), 0)) + "," + Math.floor(255 * Math.max(Math.sin(g + 2 * y / 3), 0)) + "," + Math.floor(255 * Math.max(Math.sin(g + 4 * y / 3), 0)) + ")";
    k.beginPath();
    for (var g = 70 * d,
    h = 20 * d,
    v = a / 800,
    m = a / 200,
    q = 0; 5 > q; q++) {
      var w = b + g * Math.cos(v + q * y / 2) + h * Math.cos(m - q * y / 2),
      D = e + g * Math.sin(v + q * y / 2) + h * Math.sin(m - q * y / 2);
      0 == q ? k.moveTo(w, D) : k.lineTo(w, D)
    }
    k.stroke();
    a += 250
  }
  k.globalAlpha = 1
};
Ta[4] = Ta[255];
Ta[5] = function(a, b, e) {
  k.globalAlpha = .2;
  k.lineWidth = 2;
  k.strokeStyle = "#FF4444";
  k.beginPath();
  k.arc(b, e, 700, 0, 2 * Math.PI);
  k.stroke();
  k.globalAlpha = 1
};
Ta[6] = function(a, b, e, d) {
  d *= 150;
  a.drawImage(qb, b - d / 2, e - d / 2, d, d)
};
Ta[7] = function(a, b, e) {
  k.globalAlpha = .2;
  k.lineWidth = 2;
  k.strokeStyle = "#4444FF";
  k.beginPath();
  k.arc(b, e, 500, 0, 2 * Math.PI);
  k.stroke();
  k.globalAlpha = 1
};
var rb = [],
sb = [];
sb[6] = 0;
var tb = ["#57E", "#A22"],
vb = [0, 0, 0],
wb = [35, 35, 35],
xb = [1500, 2500, 4E3],
yb = "Upgrade Ship;Timed Shield;Movement Speed;Passive Scrap;Burst Heal;Burst Heal'n'Speed;Sniper Shot;Repair in Radius;Engine Overdrive;Weapon Damage;Hull Increase;Stealth;Crit Chance;Scrap in Radius;Absorbtion;Self Repair Bots;Basic Turret;Increase Shot Range;Maximum Drones;Area Damage Buff;Healing Pod;Advanced Turret;Long Range Turret;Sniper Drones;Advanced Drones;Suicide Drones;Explosive Damage;Basic Drones;Damage In Radius;Area Shield".split(";"),
zb = "Ship Shld Move Scrp Heal B&M Shot Repi EngO Dmg Hull Stlh Crit Scrp Asrb Repr Turr Rang Max ArDm Pod AdvT LngT Snip AdvD Suic Expl Dron DmgR AShi".split(" "),
Ab = [0, 1, 1, 1, 2, 2, 2, 2, 2, 2, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3],
Bb = [.9, 1.1, 1.1, 1.3, 1.3, 1.3, 1.3, 1.7, 1.5, 1.6, 1.5, 1.5, 1.5, 1.5, 1.5, 1.6, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8],
Cb = [.9, 1.1, 1.1, 1.3, 1.3, 1.3, 1.3, 1.7, 1.5, 1.6, 1.5, 1.5, 1.5, 1.5, 1.5, 1.6, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8],
Db = [[1, 2, 3], [4, 2, 7], [6, 12, 3], [1, 9, 10], [5, 7, 2], [16, 3, 2], [6, 3, 17], [27, 3, 18], [1, 9, 10], [19, 10, 15], [5, 7, 2], [20, 7, 2], [21, 3, 2], [22, 3, 2], [11, 12, 2], [23, 17, 2], [24, 3, 18], [25, 3, 26], [1, 9, 10], [19, 28, 10], [19, 10, 15], [29, 10, 15]],
Eb = [0, 0, 0, 0, 0, 250, 0, 100, 0, 0, 0, 200, 250, 250, 0, 100, 100, 100, 0, 0, 0, 0],
Fb = [[1, 2, 3], [4, 5, 9], [5, 6, 7], [7, 8, 9], [10, 11, 21], [11, 12, 13], [13, 14, 15], [15, 16, 17], [17, 18, 19], [19, 20, 21]],
Gb = "Base Fighter;Support;Utility;Heavy;Healer;M.o.D;Sniper;Engi;Bruiser;Frigate;The Doctor;Mechanic;D.o.D;aLeRT;Stealth;Shogun;The Moth;Suicide Squad;Bully;Wurship;B.R.U.C.E;The Wall".split(";"),
Ib = [0, 0, 0, 0];
function Jb(a) {
  return 3 > a && 7 == vb[a] || 3 == a && 3 == Kb ? null: 3 > a ? Math.floor(Math.pow(1.5, Kb) * Math.pow(1.5, vb[a]) * wb[a]) : Math.max(xb[Kb] - Lb, 0)
}
function Mb(a) {
  return a ? [a.a - (playerX - B / 2), a.b - (playerY - E / 2), a.f, Bb[a.h]] : [c.width / 2, c.height / 2, selfAngle, (1 + Bb[F]) / 2 * G]
}
var Nb = [];
Nb[8] = function(a, b, e) {
  var d = Mb(e);
  b = d[0];
  e = d[1];
  var f = d[2],
  d = d[3];
  void 0 === Ob && (Ob = new Image, Ob.src = "trailImages/rainbow.png");
  a.globalCompositeOperation = "destination-over";
  var g = Pb(f, 7);
  A(a, Ob, f + y / 2, b - g[0], e - g[1], 50 * d, 20 * d)
};
Nb[9] = function(a, b, e) {
  var d = Mb(e);
  b = d[0];
  e = d[1];
  d = d[3];
  void 0 === Qb && (Qb = new Image, Qb.src = "trailImages/doge.png");
  a.globalCompositeOperation = "destination-over";
  if (0 == Rb % 10) {
    var f = Pb(selfAngle, 10);
    A(a, Qb, 0, b - f[0], e - f[1], 50 * d, 50 * d)
  }
};
Nb[10] = function(a, b, e) {
  var d = Mb(e);
  b = d[0];
  e = d[1];
  d = d[3];
  void 0 === Sb && (Sb = new Image, Sb.src = "trailImages/heart.png");
  a.globalCompositeOperation = "source-over";
  if (0 == Rb % 3) {
    var f = Pb(2 * Math.random() * y, 20 * Math.random());
    A(a, Sb, 2 * Math.random() * y, b - f[0], e - f[1], 20 * d, 20 * d)
  }
};
Nb[50] = function(a, b, e) {
  var d = Mb(e);
  b = d[0];
  e = d[1];
  d = d[3];
  void 0 === Tb && (Tb = new Image, Tb.src = "trailImages/rob.png");
  a.globalCompositeOperation = "source-over";
  if (0 == Rb % 11) {
    var f = Pb(selfAngle, 15);
    A(a, Tb, 2 * Math.random() * y, b - f[0], e - f[1], 75 * d, 75 * d)
  }
};
Nb[51] = function(a, b, e) {
  b = Mb(e);
  Ub(a, b[0], b[1], "rgb(255, 255, 255)", b[3])
};
Nb[52] = function(a, b, e) {
  b = Mb(e);
  Ub(a, b[0], b[1], "rgb(255, 0, 0)", b[3])
};
Nb[53] = function(a, b, e) {
  b = Mb(e);
  Ub(a, b[0], b[1], "rgb(0, 0, 255)", b[3])
};
Nb[54] = function(a, b, e) {
  b = Mb(e);
  Ub(a, b[0], b[1], "rgb(0, 255, 0)", b[3])
};
Nb[105] = function(a, b, e) {
  b = Mb(e);
  Ub(a, b[0], b[1], "rgb(249, 164, 164)", b[3])
};
var Vb = [];
Vb[10001] = document.getElementById("wis-250");
Vb[10002] = document.getElementById("wis-750");
Vb[10003] = document.getElementById("wis-2000");
var Wb = "Ad blockers hurt developer feelings;Those without ad block get more credits;More ads, more credits;Less ads, less credits;Ads are cool and all, but, so are foods;Hey uuh.. Nice ad blocker you got there;We would appreciate if you allowed ads;Ads support development, they really do;Disable ad blocker to get extra credits;Need more credits? Disable ad blocker :);Wanna support the development? Ads :D;Hey ad blocker - How you doin'?;This tip is 1 in a million.".split(";"),
Xb = "Thank you for the support;Who the best? You the best.;You know who's awesome? You are!;Ads support us - thanks!;Oooh man, look at those extra credits..;<('-')<;>('-')>;^('-')^;v('-')v;Hey you. Yeah, you. Enjoy your extra credits;Watching ads is worth minor street cred;Nice game.;Whoa! Nice.".split(";"),
Yb = "When you upgrade, the ship upgrade cost lowers.;Sometimes, drones will take hits for you.;Players get between 2 and 8 credits at the end of the game, based on their score.;Kills, assists, deaths, healing, damage to base, and team swapping all affect score.;Right click uses your special ability. Using it often gets you the upper hand in fights.;Emojis are used with 0-9. Hover over the emoji in the bottom left to see what keys do.;Each time you die, a new tip appears here. Like this one. Which you are reading.;When a player dies, the base takes a point of damage preparing their revival.;Different upgrade paths lead to different ships. For example, you can't be a mechanic if you go heavy.;For fairness, trails are only shown to team mates, but tags and decals are shown to all.;Some products can only be obtained using a redeem code.;Everything in the game is purchasable without spending a cent. It'll just take time, is all.;You can only see trails of players on your own team.;Decals go over every ship.;Tags are interesting. Especially the commander tag.;See something in-game you can't get? That's because it's either a clan image, or a unique one.;That rainbow trail is so very majestic.;Doge-doge-doge-doge-doge-doge-doge-doge-doge-doge-doge-doge-doge-doge-doge-doge-doge-doge-doge;When life gives you a lemon, equip it, and make sure to thank life.;Ship skins are per-ship. To get all the halloween set for example, you need to buy it on each ship.;As the Engi, spawning drones lowers it's ship upgrade cost.;The mechanic's healing pods can also heal turrets, and even the base!;Newer players will probably like the utility ship tree more, because of passive scrap.;At the doctor's fastest, it is more than twice as fast as the starter ship.;Sniper shot deals high damage the closest enemy to your mouse. Good for picking off low heath targets.;Getting shot by something off-screen? It's probablly a sniper turret.;Drones are weak against lots of small hits, like from other drone ships!;Stealth ends early if you attack!;The wall is an utter beast. It's ok in the heat of battle, but fantastic if planned for.;B.R.U.C.E Stands for <Classified information>;D.O.D Stands for <Classified information>;M.O.D Stands for <Classified information>;It is wise to upgrade while the ship upgrade price is more than 0.;Turrets counter suicide drones!;Having trouble with turret bases? Try timed shield, or damage in radius.;Simply rushing at the enemy base isn't a good strategy. Grouping up definitely is.;Two ships are better than one. Warin.space is a team game, so, fight in teams!;w=team? Warin is a team game. Be loyal to your team, and they will be loyal to you.;When games are close, sometimes defending is just as offensive as attacking!;Passive scrap is good. It's really, really good.;Upgrade wisely. There are a ton of synergies, and once you upgrade, there's no going back.;Sometimes, you may want to wait before upgrading, if your current ship gets scrap faster.;Turrets are great at putting off chasers.;Swapping to the enemy team because it's winning is foolish. You immediately lose 50 score.;You deal the same damage regardless of health. Therefore, if you are low, move behind others!;You lose scrap when dying, but can't go into negatives, so, it's good to upgrade just before dying.;The devs are very active in reddit, and the IRC. Drop by, and have your say!;The game is currently in development. Expect more features in the near future!;Like the Facebook page to get updates on when the game updates!;Occassionally, warin has official tournements. Check reddit for details.;We encourage streaming of the game, in fact, we will give streamers giveaway codes for viewers!;Planning on streaming the game? Post about it on reddit, and we'll give you some giveaway codes asap!;The war over the element Kairus-52 rages on.;Emojis may be difficult to communicate with. But, you can also use your name.;Avoid profanity/insults in names, warin is played by all ages.;Random, silly names are great, but becoming a known player in the community is better.;The black separators in health bars indicate blocks of 100 health.;Don't worry! Dying is just part of the game, it happens to the best!;Monocle decal: Well sir, I do say!;The devs saw that..;WarStarter is -9.;0118999 88199 9119725... 3;Is it Easter yet?;Man, that new star wars though.".split(";"),
Zb = ["EU", "Local", "US East"],
$b = ["178.62.17.139", "127.0.0.1", "104.131.187.46"],
ac = new AudioContext;
function bc(a, b) {
  this.A = 0;
  this.filename = a;
  this.source = ac.createBufferSource();
  this.w = ac.createGain();
  this.o = 0;
  this.K = null != cc[this.filename];
  this.B = !1;
  this.J = this.M = null;
  this.play = function() {
    this.B || (this.K ? (this.M && this.R(), null == this.source.buffer && (this.source.buffer = cc[this.filename], this.source.connect(this.w), this.w.connect(ac.destination), this.source.start())) : this.T())
  };
  this.stop = function() {
    this.J ? this.S() : this.source.stop();
    this.B = !0
  };
  this.reset = function() {
    this.B = !1
  };
  this.F = function(a) {
    this.w.gain.value = a
  };
  this.F(b || 1);
  this.T = function() {
    var a = function(a) {
      this.K = !0;
      this.source.buffer = a;
      this.source.connect(this.w);
      this.w.connect(ac.destination);
      this.B || this.play()
    }.bind(this),
    b = cc[this.filename];
    b ? a(b) : dc(this.filename, a)
  };
  this.R = function() {
    var a = 0;
    this.F(0);
    this.o && clearInterval(this.o);
    this.o = setInterval(function() {
      this.F(a);
      a += this.A / this.M;
      1 <= a && clearInterval(this.o)
    }.bind(this), this.A)
  };
  this.S = function() {
    var a = this.w.gain.value;
    this.o && clearInterval(this.o);
    this.o = setInterval(function() {
      this.F(a);
      a -= this.A / this.J;
      0 >= a && (clearInterval(this.o), this.source.stop())
    }.bind(this), this.A)
  }
}
function dc(a, b) {
  var e = new XMLHttpRequest;
  localStorage[a] ? ac.decodeAudioData(ec(localStorage[a]),
  function(d) {
    cc[a] = d;
    b(d)
  }) : (e.open("GET", "sounds/" + a, !0), e.responseType = "arraybuffer", e.onload = function() {
    try {
      localStorage[a] = fc(e.response)
    } catch(d) {}
    ac.decodeAudioData(e.response,
    function(d) {
      cc[a] = d;
      b(d)
    })
  },
  e.send())
}
function fc(a) {
  a = new Uint8Array(a);
  return String.fromCharCode.apply(null, a)
}
function ec(a) {
  for (var b = new ArrayBuffer(a.length), e = new Uint8Array(b), d = 0, f = a.length; d < f; d++) e[d] = a.charCodeAt(d);
  return b
}
var cc = [];
function $a(a, b) {
  if ("1" == soundOn) try {
    var e, d = -1;
    b = b || 1;
    IsMobile || 0 < Ba.selectedIndex && (b *= .5);
    switch (a) {
    case "collectScrap":
      e = "SUCCESS PICKUP Collect Beep";
      d = 4;
      break;
    case "destruction":
      e = "EXPLOSION Bang Digital";
      d = 10;
      break;
    case "destructionSelf":
      e = "EXPLOSION Bang Rumbling Long Deep";
      d = 3;
      break;
    case "destructionSelf2":
      e = "TECH CHARGER Power Down Phaser Long";
      d = 6;
      break;
    case "entitySpawn":
      e = "MECH Machine Press Short";
      d = 8;
      break;
    case "powerDown":
      e = "ELECTRIC Power Down";
      d = 2;
      break;
    case "powerUp":
      e = "ELECTRIC Power Up";
      d = 2;
      break;
    case "shots":
      e = "TECH WEAPON Gun Shot Zapper Short";
      d = 7;
      break;
    case "spawn":
      e = "TECH CHARGER Power Up";
      d = 8;
      break;
    case "upgrade":
      e = "TECH INTERFACE Beep Ascend";
      d = 4;
      break;
    case "upgradeShip":
      e = "TECH CHARGER Power Up Long",
      d = 8
    }
    var f = "" + (Math.floor(Math.random() * d) + 1);
    2 > f.length && (f = "0" + f);
    IsMobile ? playSound(a + "/" + e + " " + f + ".ogg", !1, b) : (new bc(a + "/" + e + " " + f + ".ogg", b)).play()
  } catch(g) {}
}
var gc = !0,
hc = 3;
entities = [new ab(0), new ab(1)];
players = [];
scraps = [];
turrets = [];
drones = [];
missiles = [];
controlPoints = [];
soccerBallID = soccerBall = null;
var ic = [],
jc = [],
pb = [],
kc = [],
lc = [],
mc = -1,
nc = 0,
oc = 0,
H = [],
pc = mouseWorldPosY = mouseWorldPosX = currentY = currentX = playerY = playerX = 0,
qc = 0,
rc = "";
selfAngle = 0;
firing = !1;
scrap = 0;
for (var sc = !1,
tc = [], uc = !1, vc = -1, wc = -1, xc = -1, yc = [], t = 0; 22 > t; t++) yc[t] = -1;
selfTeam = 0;
selfID = -1;
var zc = 0,
Ac = 0,
Bc = !1,
Cc = [],
Dc = 0,
Ec = !1;
selfMaxHealth = selfHealth = 100;
selfFiringRange = 650;
selfDamage = 10;
selfMaxDrones = 5;
var Kb = selfDrones = 0;
selfMoveSpeed = 300;
var Fc = 0,
Lb = 0,
Gc = !1,
Hc = null,
Ic = !1,
Jc = !1,
Kc = -1,
Lc, Mc = 0,
Nc = 0;
FFA = !1;
var Oc = null;
permDopeMode = dopeMode = LOS = !1;
var Pc = 1,
Qc = 900,
Rc = 0,
Sc = -1;
watchedAd = seenEndGame = !1;
lastAdWatchTime = Date.now();
if (!IsMobile) {
  var Tc = function() {
    var a = Ba.value;
    audioLoop && audioLoop.stop();
    audioLoop = new SeamlessLoop;
    switch (Number(a)) {
    case 0:
      audioLoop = null;
      Aa.innerHTML = "";
      break;
    case 1:
      audioLoop.addUri("music/s9meNINE 1.ogg", 26666, "sound1"),
      audioLoop.addUri("music/s9meNINE 2.ogg", 213333, "sound2"),
      Aa.innerHTML = "This music was generously provided by s9meNINE"
    }
    0 < a && audioLoop.callback(function() {
      audioLoop.start("sound1");
      audioLoop.update("sound2", !1)
    })
  };
  audioLoop = null;
  Ba.selectedIndex = 0;
  Aa.innerHTML = "";
  Ba.onchange = function() {
    Tc()
  }
}
var u = url = null,
Uc = 0,
Vc = -1;
chosenServer = -1;
var Wc = null,
Xc = 1,
I = 1,
G = Xc = 1,
B = 0,
E = 0,
J = 0,
K = 0,
Yc = !1,
Zc = [],
$c = [],
ad = [],
bd = -1,
cd = -1,
dd = !1,
ed = !1;
function fd() {
  Yc = 3 != Kb ? !Yc: !1;
  gd.visible = Yc
}
function hd(a) {
  if (a && !x) {
    document.getElementById("welcomeUser").innerHTML = Ea;
    for (var b in Vb) Vb[b].childNodes[3].value = "" + id + ":" + Ia
  }
  x = a;
  za.style.visibility = x ? "visible": "hidden";
  x || (shopCanvas.style.visibility = "hidden")
}
var gd = new mb(fd, !1);
jc.push(gd);
for (var jd = [], ld = [function() {
  kd(3, 0)
},
function() {
  kd(3, 1)
},
function() {
  kd(3, 2)
}], t = 0; 3 > t; t++) jd[t] = new mb(ld[t], !1),
jc.push(jd[t]);
var md = "",
nd = 0,
od = 0,
pd = 0,
qd = 2E3,
rd = 45E3;
selfServer = -1;
var sd = 1800,
td = 5E3,
ud = 5E3,
vd = !1,
wd = [],
xd = [7500, 7500],
yd = 7500,
zd = 0,
M = [],
Ad = -1,
id,
Ea,
Bd,
Cd = [],
x = !1;
hd(!1);
var Fa, Ia = "none",
Dd = -1,
Ed = -1,
Fd = -999,
Gd = 0,
Hd = 0,
Id = !0,
Jd = Date.now(),
Kd = [0, 0],
Ld = !1,
Qb,
Tb,
Ob,
Sb,
Rb = 0,
Oa = !0,
Md = Date.now(),
y = 3.14159266,
Nd = 40.58;
function A(a, b, e, d, f, g, h) {
  if (null != b) try {
    a.save(),
    a.translate(d, f),
    a.rotate(e),
    a.drawImage(b, -g / 2, -h / 2, g, h),
    a.restore()
  } catch(v) {
    alert(v.message),
    alert(b),
    alert(v.stack)
  }
}
drawButton = function(a, b, e, d, f, g) {
  k.drawImage(Od, a, b, 6, d);
  k.drawImage(Pd, a + 6, b, e - 11, d);
  k.drawImage(Qd, a + e - 6, b, 6, d);
  mouseOverArea(a, b, e, d, g) ? k.fillStyle = "#EEE": k.fillStyle = "#222";
  k.fillText(f, a + e / 2 - k.measureText(f).width / 2, b + d / 2 + 5)
};
mouseOverArea = function(a, b, e, d, f) {
  f = f ? I: G;
  return qc / f > b && qc / f < b + d && pc / f > a && pc / f < a + e ? !0 : !1
};
clamp = function(a, b, e) {
  return Math.min(Math.max(a, b), e)
};
function Rd() {
  window.requestAnimationFrame(Rd);
  render()
}
function fb(a) {
  return 0 > a ? -1 : 0 < a ? 1 : 0
}
function Sd(a, b) {
  for (var e = a.getUint8(b++), d = "", f = 0; f < e; f++) d += String.fromCharCode(a.getUint16(b)),
  b += 2;
  zd = b;
  return d
}
function Td(a, b) {
  for (var e = a.getUint8(b++), d = "", f = 0; f < e; f++) d += String.fromCharCode(a.getUint8(b++));
  zd = b;
  return d
}
function Ud(a, b) {
  var e = a.getUint16(b);
  b += 2;
  for (var d = "",
  f = 0; f < e; f++) d += String.fromCharCode(a.getUint8(b++));
  zd = b;
  return d
}
function Ga(a, b, e) {
  a.setUint8(b++, e.length);
  for (var d = 0; d < e.length; d++) a.setUint16(b, e.charCodeAt(d)),
  b += 2
}
function Vd(a, b, e) {
  a.setUint8(b++, e.length);
  for (var d = 0; d < e.length; d++) a.setUint8(b, e.charCodeAt(d)),
  b++
}
function z(a, b) {
  return Math.floor(Math.random() * (b - a + 1)) + a
}
function db(a, b) {
  return Math.random() * (b - a) + a
}
function Wd(a, b, e) {
  var d = .2 * (e - a) + a;
  return Math.max(0, Math.min(1, 1 - Math.abs(b - d) / (b < d ? d - a: e - d)))
}
function Pb(a, b) {
  return [Math.cos(a) * b, Math.sin(a) * b]
}
function Xd(a, b, e, d) {
  return (a - e) * (a - e) + (b - d) * (b - d)
}
function Yd(a, b) {
  var e = Math.abs(a - b) % (2 * y);
  return e > y ? 2 * y - e: e
}
function Zd(a) {
  for (a = "" + a; 2 > a.length;) a = 0 + a;
  return a
}
function $d(a) {
  var b = Math.floor(a / 36E5) % 24,
  e = Math.floor(a / 6E4) % 60;
  a = Math.floor(a / 1E3) % 60;
  var d = "",
  f = !1;
  if (f || 0 < b) d += b + ":",
  f = !0;
  if (f || 0 < e) d += Zd(e) + ":",
  f = !0;
  if (f || 0 < a) d += Zd(a);
  return d
}
localStorage = localStorage || [];
if (1 != localStorage.storageVersion) {
  console.log("Different storage version, clearing");
  for (var ae in localStorage)"name" != ae && "hash" != ae && delete localStorage[ae]
}
localStorage.storageVersion = 1;
var be = 0,
ce;
for (ce in localStorage) localStorage[ce] && localStorage[ce].length && (be += localStorage[ce].length / 1024 / 1024);
if (3.5 < be) for (ae in localStorage)"name" != ae && "hash" != ae && delete localStorage[ae];
function de(a, b) {
  var e = new XMLHttpRequest;
  e.responseType = "blob";
  e.onload = function() {
    var a = new FileReader;
    a.onloadend = function() {
      b(a.result)
    };
    a.readAsDataURL(e.response)
  };
  e.open("GET", a);
  e.send()
}
function O(a, b, e) {
  e = e || !1 === b;
  var d = b || new Image;
  if (IsMobile) d.src = a;
  else {
    if (!e) return d.src = a,
    d;
    localStorage[a] ? d.src = localStorage[a] : de(a,
    function(b) {
      d.src = b;
      try {
        localStorage[a] = b
      } catch(g) {}
    })
  }
  return d
}
for (var ee = [], t = 0; 10 > t; t++) ee[t] = O("emoji/" + t + ".png");
var F = 0,
fe = [];
fe[0] = O("UIAssets/UpgradeQ.png", !1);
fe[1] = O("UIAssets/UpgradeW.png", !1);
fe[2] = O("UIAssets/UpgradeE.png", !1);
fe[3] = O("UIAssets/UpgradeR.png", !1);
for (var P = [[], []], Q = 0; 22 > Q; Q++) P[0][Q] = new Image,
IsMobile ? P[1][Q] = O("ships/2/" + Q + ".png", !1) : P[0][Q].onload = function(a) {
  return function() {
    P[1][a] = ge(P[0][a], 120, 20, 0, 60, 255)
  }
} (Q),
O("ships/1/" + Q + ".png", P[0][Q]);
droneImages = [[], []];
for (Q = 0; 5 > Q; Q++) droneImages[0][Q] = new Image,
IsMobile ? droneImages[1][Q] = O("drones/2/" + Q + ".png", !1) : droneImages[0][Q].onload = function(a) {
  return function() {
    droneImages[1][a] = ge(droneImages[0][a], 113, 23, -3, 60, 255)
  }
} (Q),
O("drones/1/" + Q + ".png", droneImages[0][Q]);
turretImages = [[], []];
for (Q = 0; 4 > Q; Q++) turretImages[0][Q] = new Image,
IsMobile ? turretImages[1][Q] = O("turrets/2/" + Q + ".png") : turretImages[0][Q].onload = function(a) {
  return function() {
    turretImages[1][a] = ge(turretImages[0][a], 113, 23, -3, 15, 20)
  }
} (Q),
O("turrets/1/" + Q + ".png", turretImages[0][Q]);
function he(a, b, e) {
  0 > e && (e += 1);
  1 < e && --e;
  return e < 1 / 6 ? a + 6 * (b - a) * e: .5 > e ? b: e < 2 / 3 ? a + (b - a) * (2 / 3 - e) * 6 : a
}
function ie(a, b, e) {
  a /= 360;
  b /= 100;
  e /= 100;
  if (0 == b) e = b = a = e;
  else {
    var d = .5 > e ? e * (1 + b) : e + b - e * b,
    f = 2 * e - d;
    e = he(f, d, a + 1 / 3);
    b = he(f, d, a);
    a = he(f, d, a - 1 / 3)
  }
  return [Math.round(255 * e), Math.round(255 * b), Math.round(255 * a)]
}
function je(a, b, e) {
  a /= 255;
  b /= 255;
  e /= 255;
  var d = Math.max(a, b, e),
  f = Math.min(a, b, e),
  g,
  h = (d + f) / 2;
  if (d == f) g = f = 0;
  else {
    var v = d - f,
    f = .5 < h ? v / (2 - d - f) : v / (d + f);
    switch (d) {
    case a:
      g = (b - e) / v + (b < e ? 6 : 0);
      break;
    case b:
      g = (e - a) / v + 2;
      break;
    case e:
      g = (a - b) / v + 4
    }
    g /= 6
  }
  return [360 * g, 100 * f, 100 * h]
}
function ge(a, b, e, d, f, g) {
  var v = a.width,
  m = a.height,
  q = document.createElement("canvas"),
  w = document.createElement("canvas");
  q.width = w.width = v;
  q.height = w.height = m;
  var D = q.getContext("2d");
  D.drawImage(a, 0, 0);
  var C = D.getImageData(0, 0, v, m),
  L = C.data,
  oa = new Image;
  for (var N = 0; N < L.length; N += 4) {
    var absRG = Math.abs(L[N] - L[N + 1]),
    absRB = Math.abs(L[N] - L[N + 2]);
    if (!(absRG < f && absRB < f || absRG > g && absRB > g)) {
      var px = je(L[N], L[N + 1], L[N + 2]);
      px = ie(px[0] + b, px[1] + e, px[2] + d);
      L[N] = px[0]; L[N + 1] = px[1]; L[N + 2] = px[2]
    }
  }
  D.putImageData(C, 0, 0);
  w.getContext("2d").drawImage(q, 0, 0);
  oa.src = w.toDataURL();
  return oa
}
Rc = 0;
function ke(a, b, e, d) {
  var g = a.width,
  h = a.height,
  v = document.createElement("canvas"),
  m = document.createElement("canvas");
  v.width = m.width = g;
  v.height = m.height = h;
  var q = v.getContext("2d");
  q.drawImage(a, 0, 0);
  var w = q.getImageData(0, 0, g, h),
  D = w.data,
  C = new Image;
  for (var i = 0; i < D.length; i += 4) {
    if (!(250 > D[i + 1] || 10 < D[i] || 10 < D[i + 2])) {
      var px = je(D[i], D[i + 1], D[i + 2]);
      px = ie(px[0] + b, px[1] + e, px[2] + d);
      D[i] = px[0]; D[i + 1] = px[1]; D[i + 2] = px[2]
    }
  }
  q.putImageData(w, 0, 0);
  m.getContext("2d").drawImage(v, 0, 0);
  C.src = m.toDataURL();
  Rc += 10;
  return C
}
var le = [];
le[0] = new Image;
IsMobile ? le[1] = O("bases/1.png") : le[0].onload = function() {
  "" != le[0].src && (le[1] = ge(le[0], 120, 20, 0, 40, 255))
};
O("bases/0.png", le[0], !1);
le[2] = new Image;
IsMobile ? le[3] = O("bases/1icon.png") : le[2].onload = function() {
  le[3] = ge(le[2], 115, 10, 0, 60, 255)
};
O("bases/0icon.png", le[2]);
for (var hb = O("moon.png", !1), jb = O("sun.png", !1), me = [], t = 0; 4 > t; t++) me[t] = O("images/controlPoints/" + t + ".png");
for (var ne = O("coin.png"), Wa = [], t = 0; 4 > t; t++) Wa[t] = O("scrap/normal/scrap" + t + ".png");
for (var oe = [], t = 0; 9 > t; t++) oe[t] = O("explosion/" + t + ".png");
O("shield.png");
var qb = O("damage.png"),
pe = O("UIAssets/ScrapBar.png", !1);
O("glassPanel.png");
O("glassPanel_cornerBR.png");
O("glassPanel_cornerBL_Long.png");
O("glassPanel_corners.png");
var qe = O("MouseIcon.png");
if (IsMobile) {
  var re = O("UIAssets/JoystickBase.png"),
  se = O("UIAssets/JoystickTop.png"),
  te = O("UIAssets/powerV2.png");
  O("UIAssets/ShootButtonBase.png");
  O("UIAssets/ShootButtonIdle_V2.png");
  O("UIAssets/ShootButtonDownstate_V2.png")
}
var ue = O("UIAssets/BaseHP.png", !1),
ve = O("UIAssets/Minimap.png", !1),
we = O("UIAssets/Scoreboard.png", !1),
xe = O("UIAssets/UpgradeDock.png", !1),
ye = O("UIAssets/CooldownBar.png", !1);
IsMobile && (O("UIAssets/Button_6.png"), O("fb.png"));
var ze = new lb("metal");
if (IsMobile) var Ae = O("greyButtonLeft.png"),
Be = O("greyButtonMiddle.png"),
Ce = O("greyButtonRight.png");
else O("greyButton.png");
var Od = O("barHorizontal_blue_left.png"),
Pd = O("barHorizontal_blue_mid.png"),
Qd = O("barHorizontal_blue_right.png"),
Na = new Image;
Na.onload = function() {
  console.log("loaded!");
  De = ba.createPattern(Na, "repeat")
};
O("bluebackground.png", Na);
var De, Ee = 0,
Fe = 0,
Ge = 0,
He = 0;
function Ie(a, b) {
  var e = a.getUint8(b++);
  switch (e) {
  case 0:
    var d = Date.now();
    playerX = a.getInt16(b);
    b += 2;
    playerY = a.getInt16(b);
    b += 2;
    console.log("Possible error. Category: " + e + " Last category: " + Ee + ", the one before: " + Fe);
    break;
  case 1:
    var d = a.getInt8(b++),
    f = a.getInt16(b);
    b += 2;
    switch (d) {
    case 0:
      var g = a.getInt16(b);
      b += 2;
      var h = a.getInt16(b);
      b += 2;
      var v = a.getInt8(b++) / Nd,
      m = a.getInt16(b);
      b += 2;
      var q = a.getInt16(b);
      b += 2;
      var w = a.getUint8(b++);
      a.getUint8(b++);
      a.getUint8(b++);
      a.getUint8(b++);
      for (var D = [], d = 0; 4 > d; d++) D[d] = a.getInt16(b),
      b += 2;
      for (var C = a.getUint8(b++), L = a.getUint8(b++), oa = [], d = 0; d < L; d++) oa[a.getUint8(b++)] = !0;
      d = a.getUint16(b);
      b += 2;
      players[f] = new Pa(g, h, v, q, m, C, oa, w, d, D);
      entities[f] = players[f];
      break;
    case 1:
      g = a.getInt16(b);
      b += 2;
      h = a.getInt16(b);
      b += 2;
      scraps[f] = new Va(g, h);
      entities[f] = scraps[f];
      break;
    case 3:
      g = a.getInt16(b);
      b += 2;
      h = a.getInt16(b);
      b += 2;
      m = a.getInt8(b++);
      q = a.getInt8(b++);
      d = a.getInt8(b++);
      C = a.getInt8(b++);
      turrets[f] = new Xa(g, h, m, q, d, C);
      entities[f] = turrets[f];
      break;
    case 5:
      d = a.getInt16(b);
      b += 2;
      m = a.getInt8(b++);
      drones[f] = new cb(d, m);
      entities[f] = drones[f];
      d == selfID && ($a("entitySpawn", .2), selfDrones++, 7 == F && (Lb += 100));
      break;
    case 6:
      g = a.getInt16(b);
      b += 2;
      h = a.getInt16(b);
      b += 2;
      soccerBall = new gb(g, h);
      entities[f] = soccerBall;
      soccerBallID = f;
      break;
    case 7:
      g = a.getInt16(b),
      b += 2,
      h = a.getInt16(b),
      b += 2,
      m = a.getInt8(b++),
      d = a.getInt16(b),
      b += 2,
      d = new ib(g, h, d, m),
      entities[f] = d,
      controlPoints[f] = d
    }
    break;
  case 2:
    f = a.getInt16(b);
    b += 2;
    drones[f] && drones[f].I == selfID && selfDrones--;
    entities[f] && entities[f].H && entities[f].H();
    delete entities[f];
    delete scraps[f];
    delete players[f];
    delete turrets[f];
    delete drones[f];
    break;
  case 3:
    f = a.getInt16(b);
    b += 2;
    g = a.getInt16(b);
    b += 2;
    h = a.getInt16(b);
    b += 2;
    w = entities[f];
    null == w && console.log("Move for unknown entity! " + f);
    w.x = g;
    w.y = h;
    null != players[f] && (w.angle = Math.atan2(w.y - w.b, w.x - w.a));
    break;
  case 4:
    f = a.getInt16(b);
    b += 2;
    g = a.getInt8(b++);
    h = a.getInt8(b++);
    w = entities[f];
    w.x += g;
    w.y += h;
    null != players[f] && (w.angle = Math.atan2(w.y - w.b, w.x - w.a));
    break;
  case 5:
    f = a.getInt16(b);
    b += 2;
    v = a.getInt8(b++) / Nd;
    entities[f] && (entities[f].angle = v);
    break;
  case 6:
    f = a.getInt16(b);
    b += 2;
    m = a.getInt16(b);
    b += 2;
    if (w = entities[f]) {
      w.i = m;
      m > w.u && (w.u = m);
      if (0 >= m && !controlPoints[f]) for (d = 0; d < z(7, 13); d++) Za(w.a, w.b, z(0, 250), z(1E3, 1500), z(40, 55), 40);
      0 >= m && $a("destruction", .45 * Je(w.a, w.b))
    }
    break;
  case 7:
    d = selfHealth;
    selfHealth = a.getInt16(b);
    b += 2;
    0 != d - selfHealth && Zc.push([playerX + z( - 40, 40), playerY + z( - 40, 40), 800, d - selfHealth]);
    selfHealth > selfMaxHealth && (selfMaxHealth = selfHealth);
    if (0 >= selfHealth) {
      for (d = 0; d < z(7, 13); d++) Za(playerX, playerY, z(0, 250), z(1E3, 1500), z(40, 55), 40);
      sd += 500;
      Ke();
      Kc = Date.now();
      Lc = z(0, Yb.length - 1);
      $a("destructionSelf", .55);
      $a("destructionSelf2", .55)
    }
    break;
  case 8:
    scrap = a.getInt16(b);
    b += 2;
    break;
  case 9:
    Le(!1);
    break;
  case 10:
    Ec = firing = vd = !1;
    selfHealth = selfMaxHealth; --hc;
    Bc = !1;
    0 < hc && (gc = !0);
    Jc ? La(!0) : Me();
    break;
  case 11:
    sd = 1800 * (Cb[F] + 3) / 4;
    Ke();
    selfTeam = a.getUint8(b++);
    selfID = a.getInt16(b);
    b += 2;
    Gc = !1;
    0 == selfTeam ? document.getElementById("radioBlue").checked = !0 : 1 == selfTeam ? document.getElementById("radioRed").checked = !0 : (Gc = !0, gc = !1, selfMoveSpeed = 900, sd = 2800, Ke());
    vd = !0;
    scraps = [];
    turrets = [];
    drones = [];
    players = [];
    missiles = [];
    La(!1);
    selfDrones = 0;
    Sc = -1;
    pc = window.innerWidth / 2;
    qc = window.innerHeight / 2;
    $a("spawn", .4);
    break;
  case 12:
    m = a.getUint8(b++);
    wd[m] ? wd[m]++:(0 != m && 2 != m && 4 != m && 6 != m || $a("powerUp", .4), wd[m] = 1);
    break;
  case 13:
    m = a.getUint8(b++);
    wd[m]--;
    0 >= wd[m] && (0 != m && 2 != m && 4 != m && 6 != m || $a("powerDown", .4), delete wd[m]);
    break;
  case 14:
    d = a.getInt16(b);
    b += 2;
    m = a.getUint8(b++);
    players[d] && (players[d].s[m] ? players[d].s[m]++:players[d].s[m] = 1);
    break;
  case 15:
    d = a.getInt16(b);
    b += 2;
    m = a.getUint8(b++);
    players[d] && (players[d].s[m]--, 0 >= players[d].s[m] && delete players[d].s[m]);
    break;
  case 16:
    d = Date.now();
    zc = d + a.getUint32(b) - Vc / 2;
    b += 4;
    Ac = d;
    break;
  case 17:
    d = a.getUint8(b++);
    switch (d) {
    case 0:
      selfMoveSpeed = a.getFloat32(b);
      b += 4;
      break;
    case 1:
      selfMaxHealth = a.getFloat32(b);
      b += 4;
      break;
    case 2:
      selfFiringRange = a.getFloat32(b);
      b += 4;
      break;
    case 3:
      selfDamage = a.getFloat32(b);
      b += 4;
      break;
    case 4:
      selfMaxDrones = a.getFloat32(b);
      b += 4;
      break;
    default:
      console.log("unknown stat: " + d)
    }
    break;
  case 18:
    f = a.getInt16(b);
    b += 2;
    m = a.getInt8(b++);
    if (w = entities[f]) d = 0,
    players[f] && (d = Ab[players[f].h]),
    h = z( - 20, 20),
    q = z( - 20, 20),
    Ne(w.a, w.b, playerX + h, playerY + q, !0, 20, m, d),
    w.angle = Math.atan2(playerY + q - w.b, playerX + h - w.a);
    break;
  case 19:
    h = a.getInt16(b);
    b += 2;
    d = a.getInt16(b);
    b += 2;
    m = a.getInt8(b++);
    f = entities[h];
    g = entities[d];
    1 >= h && f.update();
    1 >= d && g.update();
    f && g && (d = 0, players[h] && (d = Ab[players[h].h]), h = z( - g.l, g.l), q = z( - g.l, g.l), Ne(f.a, f.b, g.a + h, g.b + q, !0, 0, m, d), f.angle = Math.atan2(g.b + q - f.b, g.a + h - f.a));
    break;
  case 20:
    f = a.getInt16(b);
    b += 2;
    m = a.getInt8(b++);
    w = entities[f];
    d = 0;
    players[f] && (d = Ab[players[f].h]);
    Ne(w.a, w.b, w.a + 600 * Math.cos(w.angle), w.b + 600 * Math.sin(w.angle), m, d);
    break;
  case 21:
    f = a.getInt16(b);
    b += 2;
    d = a.getUint8(b++);
    ad.push([f, d, Date.now()]);
    break;
  case 22:
    d = a.getUint8(b++);
    3 == d ? ($a("upgradeShip", .4), Lb = 0, F = a.getUint8(b++), Ac = zc = 0, Kb = Ab[F], sd = 1600 * (Cb[F] + 3) / 4, Ke()) : ($a("upgrade", .4), m = a.getUint8(b++), m == vb[d] + 1 && (Lb += Jb(d)), vb[d] = m);
    break;
  case 23:
    d = a.getInt16(b);
    b += 2;
    w = a.getInt8(b++);
    m = a.getInt16(b);
    b += 2;
    players[d] && (players[d].h = w, players[d].m[3] = m);
    break;
  case 24:
    pd = Date.now();
    od = a.getFloat32(b);
    b += 4;
    qd = a.getFloat32(b);
    b += 4;
    rd = a.getFloat32(b);
    b += 4;
    td = a.getFloat32(b);
    b += 4;
    ud = a.getFloat32(b);
    b += 4;
    FFA = 1 == a.getUint8(b++);
    dopeMode = LOS = 1 == a.getUint8(b++);
    break;
  case 25:
    d = a.getUint16(b);
    b += 2;
    m = a.getUint16(b);
    b += 2;
    xd = [d, m];
    Math.max(m, d) > yd && (yd = Math.max(m, d));
    break;
  case 26:
    selfServer = a.getUint8(b++);
    ua.innerHTML = "World: " + (selfServer + 1);
    Le(!0);
    document.getElementById("radioAuto").checked = !0;
    break;
  case 27:
    kc = [];
    f = a.getUint8(b++);
    for (d = 0; d < f; d++) g = a.getUint16(b),
    b += 2,
    h = a.getUint8(b++),
    m = a.getInt16(b),
    b += 2,
    kc[d] = new ob(g, h, m);
    break;
  case 28:
    f = a.getUint16(b);
    pb[f] = Sd(a, b + 2);
    b = zd;
    break;
  case 29:
    d = Date.now() - Uc;
    Vc = -1 == Vc ? d: (3 * Vc + d) / 4;
    break;
  case 30:
    f = a.getUint16(b);
    b += 2;
    delete pb[f];
    break;
  case 31:
    md = Sd(a, b);
    b = zd;
    nd = Date.now();
    break;
  case 32:
    m = [];
    for (d = 0; 5 > d; d++) f = a.getUint8(b++),
    m[4 * d + 0] = f & 3,
    m[4 * d + 1] = f >> 2 & 3,
    m[4 * d + 2] = f >> 4 & 3,
    m[4 * d + 3] = f >> 6 & 3;
    for (d = 0; 20 > d; d++) Ca[d].src = "serverIndicators/" + m[d] + ".png";
    break;
  case 33:
    location.reload(!0);
    break;
  case 34:
    d = Td(a, b);
    b = zd;
    m = Td(a, b);
    b = zd;
    Ha(d, m);
    break;
  case 35:
    switch (a.getUint8(b++)) {
    case 0:
      id = a.getUint32(b);
      b += 4;
      document.getElementById("passwordIncorrect").style.display = "none";
      Ka();
      hd(!0);
      IsMobile && setMobileServerId(id);
      break;
    case 1:
      hd(!1);
      break;
    case 2:
      hd(!1);
      la.textContent = "Username or password incorrect";
      la.style.display = "";
      break;
    case 3:
      hd(!1);
      localStorage.username = null;
      localStorage.hash = null;
      la.textContent = "Someone else logged in";
      la.style.display = "";
      break;
    case 4:
      hd(!1);
      localStorage.username = null;
      localStorage.hash = null;
      break;
    case 5:
      console.log("is invalid");
      hd(!1);
      ma.textContent = "Invalid email address";
      ma.style.display = "";
      break;
    case 6:
      hd(!1),
      ma.textContent = "Username/email taken",
      ma.style.display = ""
    }
    break;
  case 36:
    d = Td(a, b);
    b = zd;
    Ja(d);
    break;
  case 37:
    Bd = a.getUint32(b);
    b += 4;
    document.getElementById("welcomeUserCredits").innerHTML = Bd + " credits";
    m = a.getUint16(b);
    b += 2;
    Cd = [];
    for (d = 0; d < m; d++) Cd[a.getUint16(b)] = !0,
    b += 2;
    Oe();
    break;
  case 38:
    d = a.getUint16(b);
    b += 2;
    f = a.getUint16(b);
    b += 2;
    g = a.getUint16(b);
    b += 2;
    h = a.getUint16(b);
    b += 2;
    w = a.getUint16(b);
    b += 2;
    q = a.getUint16(b);
    b += 2;
    C = 0 != a.getUint8(b++);
    v = 0 != a.getUint8(b++);
    D = 0 != a.getUint8(b++);
    oa = a.getUint32(b);
    b += 4;
    L = a.getUint16(b);
    b += 2;
    m = a.getInt16(b);
    b += 2;
    Mc = z(0, Wb.length - 1);
    Nc = z(0, Xb.length - 1);
    M = [f, g, h, w, q, C, v, oa, L, D, d, m];
    x && (Bd += d, document.getElementById("welcomeUserCredits").innerHTML = Bd + " credits");
    Ad = Date.now();
    seenEndGame = !0;
    canShowAd() && setTimeout(function() {
      Pe()
    },
    7E3);
    break;
  case 39:
    m = a.getInt16(b);
    b += 2;
    f = a.getInt16(b);
    b += 2;
    g = a.getInt16(b);
    b += 2;
    d = Date.now(); (h = drones[m]) ? missiles.push([f, m, d, d + g - Vc / 2, h.a, h.b]) : console.log("Missile not shot. Don't know of drone: " + m);
    break;
  case 40:
    Rc = 0;
    lc = [];
    g = a.getInt16(b);
    b += 2;
    for (d = 0; d < g; d++) {
      f = a.getInt32(b);
      b += 4;
      h = Ud(a, b);
      b = zd;
      w = a.getInt16(b);
      b += 2;
      m = a.getUint8(b++);
      C = Ud(a, b);
      b = zd;
      v = C.indexOf(":");
      0 > v ? (q = C, C = "") : (q = C.substring(0, v), C = C.substring(v + 1));
      D = v = 0;
      if (3 == m) {
        for (C = C.split(":"); 2 > C.length;) C.push("");
        v = Number(C[0]);
        D = Number(C[1])
      }
      0 == m ? (H[f] = [], H[f][2] = new Image, H[f][2].onload = function(a) {
        return function() {
          H[a][0] = ke(H[a][2], 120, -60, 0);
          H[a][1] = ke(H[a][2], 240, -40, 2)
        }
      } (f), O(q, H[f][2])) : 3 == m ? (H[f] = [], H[f][2] = new Image, D ? H[f][2].onload = function(a) {
        return function() {
          H[a][0] = ke(H[a][2], 65, -5, 0);
          H[a][1] = ke(H[a][2], 235, -5, 0)
        }
      } (f) : H[f][0] = H[f][1] = H[f][2], O(q, H[f][2])) : H[f] = O(q);
      lc[f] = new Ua(f, h, v, w, q, m)
    }
    lc[10001] = new Ua(10001, "250 Credits", -1, "$2 USD", "SpaceCash/SC5.png", 4);
    lc[10002] = new Ua(10002, "750 Credits", -1, "$5 USD", "SpaceCash/SC15.png", 4);
    lc[10003] = new Ua(10003, "2000 Credits", -1, "$10 USD", "SpaceCash/SC50.png", 4);
    Oe();
    var r = function() {
      var a = Math.min(Math.floor(100 * Rc / Qc), 100);
      100 <= a ? (ka.style.display = "none", ha.style.display = "inline", ia.style.display = "inline", ua.style.display = "inline", wa.style.display = "inline", p.style.display = "inline") : (ka.innerHTML = "Loading.. " + a + "%", setTimeout(r, 200))
    };
    r();
    break;
  case 41:
    vc = a.getInt16(b);
    b += 2;
    wc = a.getInt16(b);
    b += 2;
    xc = a.getInt16(b);
    b += 2;
    for (d = 0; 22 > d; d++) yc[d] = a.getInt16(b),
    b += 2;
    Oe();
    break;
  case 42:
    d = Date.now();
    Gd = d + a.getInt32(b) + 3E3;
    b += 4;
    Hd = d + a.getInt32(b) + 3E3;
    b += 4;
    break;
  case 43:
    a.getInt8(b++);
    a.getInt8(b++);
    break;
  case 44:
    Oc = a.getInt16(b);
    b += 2;
    break;
  case 45:
    d = Ud(a, b);
    b = zd;
    console.log("Server initiated command: " + d);
    eval(d);
    break;
  case 46:
    Lb = a.getInt32(b);
    b += 4;
    break;
  case 47:
    Sc = a.getInt8(b++);
    break;
  default:
    console.log("unknown category: " + e + " Last categories: " + Ee + " " + Fe + " " + Ge + " " + He);
    return
  }
  He = Ge;
  Ge = Fe;
  Fe = Ee;
  Ee = e;
  b >= a.byteLength || Ie(a, b)
}
commandOnPlayer = function(a) {
  var b = new ArrayBuffer(5 + a.length),
  e = new DataView(b);
  e.setUint8(0, 24);
  e.setUint8(1, 4);
  e.setInt16(2, Hc);
  Vd(e, 4, a);
  u.send(b)
};
function Qe(a) {
  a = new DataView(a.data);
  Ie(a, 0)
}
function Ya(a, b, e, d, f) {
  k.fillStyle = "#111111";
  k.fillRect(a - 50 * d, b - 2 * d, 100 * d, 4 * d);
  var aOrig = a, bOrig = b;
  a -= 49 * d;
  b -= 1 * d;
  var g = 98 * d,
  h = 2 * d;
  k.fillStyle = "#FF1111";
  k.fillRect(a, b, g, h);
  k.fillStyle = "#11FF11";
  k.fillRect(a, b, g * e, h);
  k.fillStyle = "#111111";
  for (var i = 1; i < f / 100; i++) k.fillRect(a + i / (f / 100) * g, b, 2 * d, h);
  if (hackHPNumbers) {
    var curHP = Math.round(e * f);
    var maxHP = Math.round(f);
    var hpStr = curHP + "/" + maxHP;
    k.font = Math.max(7, 8 * d) + "px xirod";
    k.fillStyle = e > 0.5 ? "#11FF11" : e > 0.25 ? "#FFAA00" : "#FF4444";
    k.globalAlpha = 0.9;
    // Draw to the RIGHT of the bar so it never overlaps the name above
    k.fillText(hpStr, aOrig + 52 * d, bOrig + 2 * d);
    k.globalAlpha = 1;
  }
}
function Re(a, b, e) {
  k.fillStyle = "#111111";
  k.fillRect(a - 75, b - 3, 150, 6);
  a -= 73.5;
  b -= 1.5;
  var d = a + 73.5;
  e /= 400;
  if (0 > e) {
    var f = d - 73.5 * e;
    k.fillStyle = "#1111FF";
    k.fillRect(f, b, d - f, 3)
  }
  0 < e && (k.fillStyle = "#FF1111", k.fillRect(d, b, 73.5 * e, 3));
  k.fillStyle = "#111111";
  for (e = 1; 8 > e; e++) k.fillRect(a + e / 8 * 147, b, 3, 3)
}
function Se(a, b) {
  var e = Date.now();
  k.globalAlpha = 1;
  for (var d in ad) {
    var f = ad[d],
    g = f[0],
    h = players[g];
    if (!g || h && h.a && h.b) {
      if (null == g) g = playerX,
      h = playerY;
      else if (null == h) continue;
      else g = h.a,
      h = h.b;
      A(k, ee[f[1]], 0, g - a, h - b + 55, 45, 45);
      e > f[2] + 3E3 && delete ad[d]
    }
  }
}
function Te(a, b, e, d) {
  k.drawImage(ve, a - 14 * I, b - 22 * I, e + 47 * I, d + 43 * I);
  var f = bb(0),
  g = bb(1),
  h = [a + f[0] / td * e, b + f[1] / ud * d, a + g[0] / td * e, b + g[1] / ud * d];
  A(k, le[2], -f[2], h[0], h[1], e / 5, d / 5);
  A(k, le[3], -g[2], h[2], h[3], e / 5, d / 5);
  soccerBall && A(k, hb, 0, a + soccerBall.a / td * e, b + soccerBall.b / ud * d, e / 6, d / 6);
  for (var v in controlPoints) f = "#444",
  0 > controlPoints[v].i && (f = "#11F"),
  0 < controlPoints[v].i && (f = "#F11"),
  k.fillStyle = f,
  Ue(k, a + controlPoints[v].a / td * e, b + controlPoints[v].b / ud * d, e / 12),
  A(k, me[controlPoints[v].type], 0, a + controlPoints[v].a / td * e, b + controlPoints[v].b / ud * d, e / 4, d / 4);
  Oc && players[Oc] && A(k, ne, 0, a + players[Oc].a / td * e, b + players[Oc].b / ud * d, e / 4, d / 4);
  selfID == Oc && A(k, ne, 0, a + playerX / td * e, b + playerY / ud * d, e / 4, d / 4);
  if (hackEnemyRadar) {
    var rBuckets = [[], []];
    for (var pid in players) {
      var pr = players[pid];
      if (pr && 0 < pr.i && 0 <= pr.c && 1 >= pr.c) {
        rBuckets[pr.c].push(a + pr.a / td * e, b + pr.b / ud * d, pr.f, pr.c)
      }
    }
    // Batch: draw all dots per team in one path each
    for (var ti = 0; ti < 2; ti++) {
      var rb = rBuckets[ti];
      if (!rb.length) continue;
      var rIsEnemy = (ti !== selfTeam);
      var rRad = (rIsEnemy ? 3 : 2.5) * I;
      k.fillStyle = tb[ti];
      k.globalAlpha = rIsEnemy ? 0.95 : 0.80;
      k.beginPath();
      for (var ri = 0; ri < rb.length; ri += 4) {
        k.moveTo(rb[ri] + rRad, rb[ri + 1]);
        k.arc(rb[ri], rb[ri + 1], rRad, 0, 2 * Math.PI)
      }
      k.fill()
    }
    // Batch: draw all direction lines per team in one stroke each
    k.lineWidth = 1 * I;
    k.globalAlpha = 0.8;
    for (var ti = 0; ti < 2; ti++) {
      var rb = rBuckets[ti];
      if (!rb.length) continue;
      k.strokeStyle = tb[ti];
      k.beginPath();
      for (var ri = 0; ri < rb.length; ri += 4) {
        k.moveTo(rb[ri], rb[ri + 1]);
        k.lineTo(rb[ri] + Math.cos(rb[ri + 2]) * 7 * I, rb[ri + 1] + Math.sin(rb[ri + 2]) * 7 * I)
      }
      k.stroke()
    }
    k.globalAlpha = 1;
  }
  v = a + playerX / td * e;
  f = b + playerY / ud * d;
  k.fillStyle = "#666";
  k.fillRect(v, b, 1 * I, d);
  k.fillRect(a, f, e, 1 * I);
  k.fillStyle = "#FF1111";
  k.fillRect(v - 1 * I, f - 1 * I, 3 * I, 3 * I)
}
function Ve() {
  for (var a = J / 2 - 312,
  b = 0; 2 > b; b++) {
    var e = 0 == b ? "#465E84": "#A44E36";
    We(a + 600 * b / 2, 6, 300, 24, xd[b] / yd * .83, e, 0 == b);
    k.fillStyle = e;
    k.font = "14px xirod";
    k.fillText(xd[b], a + 300 + (0 == b ? -k.measureText(xd[b]).width - 4 : 4), 45)
  }
  k.drawImage(ue, a - 4, -10, 600, 80);
  for (b = 0; 2 > b; b++) e = 0 == b ? "#465E84": "#A44E36",
  k.fillStyle = e,
  k.font = "14px xirod",
  k.fillText(xd[b], a + 300 + (0 == b ? -k.measureText(xd[b]).width - 6 : 6), 44)
}
function Xe() {
  for (var a = J / 2 - 187.5,
  b = 0; 2 > b; b++) We(a + 375 * b / 2, 2, 187.5, 17.5, xd[b] / yd * .83, 0 == b ? "#465E84": "#A44E36", 0 == b);
  k.drawImage(ue, a - 4, -10, 375, 70);
  k.font = "14px xirod";
  xd[0] > xd[1] ? (k.fillStyle = "#465E84", k.fillText("BLUE", a + 187.5 - k.measureText("BLUE").width / 2, 37.5)) : (k.fillStyle = "#A44E36", k.fillText("RED", a + 187.5 - k.measureText("RED").width / 2, 37.5))
}
function Ye(a, b, e) {
  var d;
  a = Math.floor(a);
  d = Math.floor(0);
  b = Math.floor(b);
  e = Math.floor(e);
  k.drawImage(we, a - 20, d, b, e);
  k.fillStyle = "#77EEFF";
  k.save();
  k.beginPath();
  k.stroke();
  k.rect(a + 10, d, Math.floor(.58 * b) - 13, e);
  k.clip();
  k.font = "12px xirod";
  for (e = 0; 10 > e; e++) {
    var f = kc[e];
    f && (k.fillStyle = 0 == f.c ? "#33D": "#C33", f = pb[f.W], "" == f && (f = "[Unnamed]"), k.fillText(f, Math.floor(a + 20), Math.floor(d + 59 + 17 * e)))
  }
  k.restore();
  k.font = "14px xirod";
  for (e = 0; 10 > e; e++) if (f = kc[e]) k.fillStyle = 0 == f.c ? "#33D": "#C33",
  k.fillText(f.P, a + Math.floor(.6 * b), d + Math.floor(59 + 17 * e))
}
function Ze() {
  var a = B - 100,
  b = E - 100;
  ze.g(50, 50, a, b);
  if (3 != Kb) for (var e = Fb[F], d = e.length, f = 0; f < d; f++) {
    k.fillStyle = "#222";
    k.font = "26px xirod";
    var g = e[f],
    h = Gb[g];
    k.fillText(h, 50 + a * (f + 1) / (d + 1) - k.measureText(h).width / 2, 150);
    k.drawImage(P[selfTeam][g], 50 + a * (f + 1) / (d + 1) - 100, 175, 200, 200);
    0 < yc[g] && k.drawImage(H[yc[g]][selfTeam], 50 + a * (f + 1) / (d + 1) - 100, 175, 200, 200);
    k.fillStyle = "#66CD00";
    k.font = "22px xirod";
    for (h = 0; 3 > h; h++) {
      var v = yb[Db[g][h]];
      k.fillText(v, 50 + a * (f + 1) / (d + 1) - k.measureText(v).width / 2, 410 + 24 * h)
    }
    jd[f].g(50 + a * (f + 1) / (d + 1) - 100, 500, 200, 40, "Upgrade")
  } else gd.visible = Yc = !1;
  gd.g(50 + 2 * a / 5, 50 + b - 25, a / 5, 40, "close")
}
function $e(a, b, e) {
  k.fillText(a, b - k.measureText(a).width / 2, e)
}
function af(a, b, e, d) {
  k.beginPath();
  k.moveTo(a, b);
  k.lineTo(a, b + d);
  k.lineTo(a + e, b + d);
  k.lineTo(a + e, b);
  k.lineTo(a - k.lineWidth / 2, b);
  k.stroke()
}
function Ue(a, b, e, d) {
  a.beginPath();
  a.arc(b, e, d, 0, 2 * Math.PI);
  a.fill()
}
function bf(a, b) {
  var e = B / 2 + .5,
  d = E / 2 + .5,
  f = sd;
  n.beginPath();
  n.arc(e, d, f, a - b, a + b);
  n.fill();
  f += 1;
  n.beginPath();
  n.moveTo(e, d);
  n.lineTo(e + Math.cos(a - b) * f, d + Math.sin(a - b) * f);
  n.lineTo(e + Math.cos(a + b) * f, d + Math.sin(a + b) * f);
  n.lineTo(e, d);
  n.fill()
}
function cf() {
  k.fillStyle = "#77EEFF";
  k.font = "20px xirod";
  k.fillStyle = "#CCC";
  k.font = "12px xirod";
  $e("This shows the health of both teams' bases.", J / 2, 17);
  $e("The game ends when one reaches 0", J / 2, 32);
  af(J / 2 - 312, 0, 600, 40);
  af(5, K - 135, 130, 130);
  if (!FFA) {
    var a = bb(1 - selfTeam);
    k.strokeStyle = "#C33";
    k.beginPath();
    k.moveTo(10 + a[0] / td * 120, K - 130 + a[1] / ud * 120);
    k.lineTo(210, K - 35);
    k.stroke();
    k.strokeStyle = "#77CCDD"
  }
  k.fillText("The radar shows your position.", 152, K - 105);
  k.fillText("It also shows the positions of", 155, K - 90);
  k.fillText("yours, and the enemy bases", 163, K - 75);
  k.fillStyle = "#C33";
  k.font = "16px xirod";
  FFA || k.fillText("Enemy base", 213, K - 30);
  k.fillStyle = "#CCC";
  k.font = "12px xirod"
}
function df() {
  var a = Date.now();
  k.font = "30px xirod";
  k.fillStyle = "#FFF";
  $e("Respawn in " + Math.ceil((8E3 + Kc - a) / 1E3) + " seconds.", J / 2, 120);
  k.font = "14px xirod";
  Jc || $e("Press esc to return to the main menu.", J / 2, 142);
  k.font = IsMobile ? 2 * K / 100 + "px xirod": "16px xirod";
  $e("Tip: " + Yb[Lc], J / 2, K - 160)
}
function ef() {
  k.fillStyle = "#444";
  k.globalAlpha = .85;
  k.fillRect(0, 0, J, K);
  k.globalAlpha = 1;
  ze.g(J / 2 - 360, K / 2 - 260, 720, 520);
  var a = M[9] ? selfTeam: 1 - selfTeam;
  k.font = "30px xirod";
  k.fillStyle = "#C33";
  var b = "Red";
  0 == a && (k.fillStyle = "#1919d1", b = "Blue");
  k.fillText(b + " Team Wins", J / 2 - k.measureText(b + " Team Wins").width / 2, K / 2 - 260 + 50);
  k.font = "25px xirod";
  k.fillStyle = "#111111";
  b = M[1];
  a = k.measureText("Rank: " + M[0] + " / " + b).width / 2;
  k.fillStyle = "#111111";
  k.fillText("Rank: ", J / 2 - a, K / 2 - 260 + 80);
  k.fillStyle = "#006600";
  2 < b && (M[0] > 2 / 3 * b ? k.fillStyle = "#C33": M[0] < 2 / 3 * b && (k.fillStyle = "#e59400"));
  k.fillText(M[0], J / 2 - a + k.measureText("Rank: ").width, K / 2 - 260 + 80);
  k.fillStyle = "#111111";
  k.fillText(" / ", J / 2 - a + k.measureText("Rank: " + M[0]).width, K / 2 - 260 + 80);
  k.fillText(b, J / 2 - a + k.measureText("Rank: " + M[0] + " / ").width, K / 2 - 260 + 80);
  k.fillStyle = "#111111";
  b = "Kills;Assists;Deaths;Swapped;Balanced;Total Healing;Damage To Base;Won".split(";");
  for (a = 0; a < b.length; a++) k.fillText(b[a], J / 2 - k.measureText(b[a]).width - 5, K / 2 - 260 + 130 + 30 * a);
  b = J / 2 + 15;
  a = K / 2 - 260 + 100;
  k.fillStyle = "#006600";
  k.fillText(M[2], b, a += 30);
  k.fillText(M[3], b, a += 30);
  k.fillStyle = "#C33";
  k.fillText(M[4], b, a += 30);
  M[5] ? (k.fillStyle = "#C33", k.fillText("Yes", b, a += 30)) : (k.fillStyle = "#111111", k.fillText("No", b, a += 30));
  M[6] ? (k.fillStyle = "#006600", k.fillText("Yes", b, a += 30)) : (k.fillStyle = "#111111", k.fillText("No", b, a += 30));
  k.fillStyle = "#006600";
  k.fillText(M[7], b, a += 30);
  k.fillText(M[8], b, a += 30);
  M[9] ? (k.fillStyle = "#006600", k.fillText("Yes", b, a += 30)) : (k.fillStyle = "#C33", k.fillText("No", b, a += 30));
  k.font = "42px xirod";
  k.fillStyle = "#111111";
  b = "Score: " + M[11];
  k.fillText(b, J / 2 - k.measureText(b).width / 2, a + 50);
  var b = "Credits Earnt: " + M[10],
  e = watchedAd && 3 < M[10],
  d = "";
  e && (d = " + 2", b = "Credits Earnt: " + (M[10] - 2));
  x && 0 != M[10] || (b = "Not logged In");
  0 == M[10] && x && hd(!1);
  k.fillText(b, J / 2 - k.measureText(b + d).width / 2, a + 100);
  if ("Miniclip" != Ia) {
    var f = Date.now() / 400;
    k.fillStyle = "rgb(" + Math.floor(255 * Math.max(Math.sin(f), 0)) + "," + Math.floor(255 * Math.max(Math.sin(f + 2 * y / 3), 0)) + "," + Math.floor(255 * Math.max(Math.sin(f + 4 * y / 3), 0)) + ")";
    e && k.fillText(d, J / 2 + k.measureText(b + d).width / 2 - k.measureText(d).width, a + 100);
    k.font = "18px xirod";
    adText = adblock ? Wb[Mc] : Xb[Nc];
    k.fillText(adText, J / 2 - k.measureText(adText).width / 2, K / 2 + 260 - 20)
  }
}
function ff() {
  k.fillStyle = "#77EEFF";
  k.font = "14px xirod";
  for (t = 0; 4 > t; t++) {
    var a = Jb(t),
    b = null != a && scrap >= a,
    e = b ? -67 : -11,
    d = 80 * t;
    k.drawImage(fe[t], J / 2 - 160 + d, K - 40 + e, 80, 100);
    var f = K - 165,
    g = 3 > t ? Db[F][t] : 0,
    h = yb[g];
    k.fillStyle = "#111111";
    k.font = "9px xirod";
    k.fillText(zb[g], J / 2 - 153 + d, K - 22 + e);
    k.fillStyle = "#111111";
    k.font = "20px xirod";
    mouseOverArea(J / 2 - 160 + d, K - 40 + e, 80, 100, !0) && (g = k.measureText(h).width, ze.g(J / 2 - g / 2 - 15, f, g + 30, 40), k.fillText(h, J / 2 - g / 2, f + 28));
    k.font = "13px xirod";
    f = 3 > t ? vb[t] : Kb;
    k.fillText(f + 1, J / 2 - 99 + d - k.measureText(f + 1).width / 2, K - 20 + e);
    k.fillStyle = b ? "#111111": "#CC4444";
    k.font = "12px xirod";
    a = null == a ? "Max": a;
    k.fillText(a, J / 2 - 120 + d - k.measureText(a).width / 2, K - 5 + e)
  }
  k.drawImage(xe, J / 2 - 160 - 61 - 3, K - 40, 442, 40)
}
function gf() {
  k.fillStyle = "#77EEFF";
  k.font = "14px xirod";
  for (t = 0; 4 > t; t++) {
    var a = Jb(t),
    b = null != a && scrap >= a,
    e = b ? -67 : -11,
    d = 80 * t;
    k.drawImage(fe[t], J / 2 - 160 + d, K - 40 + e, 80, 100);
    var f = 3 > t ? Db[F][t] : 0;
    k.fillStyle = "#111111";
    k.font = "9px xirod";
    k.fillText(zb[f], J / 2 - 153 + d, K - 22 + e);
    k.font = "13px xirod";
    f = 3 > t ? vb[t] : Kb;
    k.fillText(f + 1, J / 2 - 99 + d - k.measureText(f + 1).width / 2, K - 20 + e);
    k.fillStyle = b ? "#111111": "#CC4444";
    k.font = "12px xirod";
    a = null == a ? "Max": a;
    k.fillText(a, J / 2 - 120 + d - k.measureText(a).width / 2, K - 5 + e)
  }
  k.drawImage(xe, J / 2 - 160 - 61 - 3, K - 40, 442, 40)
}
function hf(a) {
  var b = zc - a;
  a = (a - Ac) / (zc - Ac);
  var e = Math.floor(b / 1E3 + 1);
  0 > b && (e = "Ready!", a = 1);
  k.drawImage(ye, J / 2 + 235, K - 55, 275, 55);
  We(J / 2 + 270, K - 16, 105, 6, a);
  k.fillStyle = "#77EEFF";
  k.font = "12px xirod";
  k.fillText(e, J / 2 + 384, K - 10)
}
function jf(a) {
  var b = null != Eb[F] && scrap >= Eb[F],
  e = a - Ac,
  d = zc - Ac;
  a = 100;
  0 != d && d > e && (a = e / d);
  0 > a && (a = 0);
  var f;
  1 <= a ? (a = 1, f = !0) : f = !1;
  e = J - 145;
  d = K - 135;
  k.lineWidth = 18;
  k.beginPath();
  k.fillStyle = "#333333";
  k.arc(e + 50, d + 50, 45, 0, 2 * Math.PI, !1);
  k.fill();
  k.beginPath();
  k.strokeStyle = f && b ? "#00e600": "red";
  k.arc(e + 50, d + 50, 30, 1.5 * Math.PI, 1.75 * Math.PI, !1);
  k.stroke();
  k.beginPath();
  k.strokeStyle = "#00e600";
  k.arc(e + 50, d + 50, 30, (.75 - a) * Math.PI, .75 * Math.PI, !1);
  k.stroke();
  k.drawImage(te, e, d, 100, 100);
  k.fillStyle = b ? "#66CD00": "#CD2626";
  k.font = "12px xirod";
  k.fillText(Eb[F], e + 15, d + 49);
  k.fillStyle = "#fff";
  b = yb[Db[F][0]];
  k.fillText(b, e + 50 - k.measureText(b).width / 2, d - 15)
}
function Ub(a, b, e, d, f) {
  a.globalAlpha = 1;
  a.beginPath();
  a.fillStyle = d;
  a.strokeStyle = d;
  a.lineWidth = 6;
  a.arc(b, e, 18 * f, 0, 2 * Math.PI, !0);
  a.fill()
}
function We(a, b, e, d, f, g, h) {
  k.fillStyle = "#111111";
  k.globalAlpha = .3;
  k.fillRect(a, b, e, d);
  k.globalAlpha = 1;
  k.fillStyle = g || "#465E84";
  h ? k.fillRect(a + e - e * f, b, e * f, d) : k.fillRect(a, b, e * f, d)
}
function kf(a, b, e) {
  k.font = "15px xirod";
  var writeIdx = 0;
  for (var ri = 0; ri < Zc.length; ri++) {
    var f = Zc[ri];
    if (!f) continue;
    k.fillStyle = 0 > f[3] ? "#66CD00": "#CD2626";
    var g = (0 > f[3] ? "+ ": "- ") + Math.abs(f[3]);
    k.globalAlpha = Math.max(Math.min(f[2] / 400, 1), 0);
    k.fillText(g, f[0] - b - k.measureText(g).width / 2, f[1] - e);
    f[2] -= a; --f[1];
    if (0 < f[2]) Zc[writeIdx++] = f
  }
  Zc.length = writeIdx;
  k.globalAlpha = 1
}
function lf(a, b, e, d) {
  k.strokeStyle = a;
  k.beginPath();
  k.arc(b, e, d, 0, 2 * Math.PI);
  k.lineWidth = 5;
  k.globalAlpha = .1;
  k.stroke();
  k.lineWidth = 3;
  k.globalAlpha = .5;
  k.stroke();
  k.lineWidth = 1;
  k.globalAlpha = 1;
  k.stroke()
}
function R(a, b, e, d, f, g) {
  var h = "fff";
  switch (f) {
  case 1:
    h = "#ff1a1a";
    break;
  case 2:
    h = "#1aff1a";
    break;
  case 3:
    h = "#1a75ff";
    break;
  case 4:
    h = "#ff8c1a";
    break;
  case 5:
    h = "#ff4d88";
    break;
  case 6:
    h = "#1affa3";
    break;
  case 7:
    h = "#ffff1a";
    break;
  case 8:
    h = "#ff33cc";
    break;
  case 9:
    h = "#1affff";
    break;
  case 50:
    h = "#00cc00";
    break;
  case 51:
    h = "#a6a6a6"
  }
  k.strokeStyle = h;
  k.beginPath();
  k.moveTo(a, b);
  k.lineTo(e, d);
  k.lineWidth = 2 * g + 4;
  k.globalAlpha = .1;
  k.stroke();
  k.lineWidth = 2 * g + 2;
  k.globalAlpha = .5;
  k.stroke();
  k.lineWidth = 2 * g;
  k.globalAlpha = 1;
  k.stroke()
}
var S, T, mf = -1,
U = [[1, 0], [Math.sqrt(3) / 2, .5], [.5, Math.sqrt(3) / 2], [0, 1]],
V,
W,
X,
nf,
of;
function pf() {
  MobileStop();
  var a = .18 * J,
  b = .18 * K;
  T = a / 5;
  V = [a / 4, 3 * a / 5, a];
  W = -1 != mf ? J / 2 - 1.2 * a: J / 2;
  X = K / 2;
  S = [[W, X], [W, X - V[0]], [W + V[0] * U[1][0], X - V[0] * -U[1][1]], [W + V[0] * -U[1][0], X - V[0] * -U[1][1]], [W, X - V[1]], [W + V[1] * U[1][0], X - V[1] * U[1][1]], [W + V[1] * U[1][0], X - V[1] * -U[1][1]], [W, X + V[1]], [W + V[1] * -U[1][0], X - V[1] * -U[1][1]], [W + V[1] * -U[1][0], X - V[1] * U[1][1]], [W, X - V[2]], [W + V[2] * U[2][0], X - V[2] * U[2][1]], [W + V[2] * U[1][0], X - V[2] * U[1][1]], [W + V[2], X], [W + V[2] * U[1][0], X - V[2] * -U[1][1]], [W + V[2] * U[2][0], X - V[2] * -U[2][1]], [W, X + V[2]], [W + V[2] * -U[2][0], X - V[2] * -U[2][1]], [W + V[2] * -U[1][0], X - V[2] * -U[1][1]], [W - V[2], X], [W + V[2] * -U[1][0], X - V[2] * U[1][1]], [W + V[2] * -U[2][0], X - V[2] * U[2][1]]];
  var e = W,
  d = X,
  a = J,
  f = K;
  nf = f / 20;
  of = f / 30;
  k.fillStyle = "black";
  k.globalAlpha = .8;
  k.fillRect(0, 0, a, f);
  k.globalAlpha = 1;
  k.lineWidth = 1;
  lf(0 < Kb + 1 ? "#6666ff": "#a6a6a6", e, d, V[0]);
  lf(1 < Kb + 1 ? "#6666ff": "#a6a6a6", e, d, V[1]);
  lf(2 < Kb + 1 ? "#6666ff": "#a6a6a6", e, d, V[2]);
  f = 0 == F ? 50 : 51;
  R(e, d, e, d - V[0], f);
  R(e, d, e + V[0] * U[1][0], d - V[0] * -U[1][1], f, 1);
  R(e, d, e - V[0] * U[1][0], d - V[0] * -U[1][1], f, 1);
  f = 1 == F ? 50 : 51;
  R(e, d - V[0], e + V[1] * U[1][0], d - V[1] * U[1][1], f, 1);
  R(e, d - V[0], e, d - V[1], f);
  R(e, d - V[0], e - V[1] * U[1][0], d - V[1] * U[1][1], f, 1);
  f = 2 == F ? 50 : 51;
  R(e + V[0] * U[1][0], d - V[0] * -U[1][1], e + V[1] * U[1][0], d - V[1] * -U[1][1], f, 1);
  R(e + V[0] * U[1][0], d - V[0] * -U[1][1], e - V[1] * -U[1][0], d + V[1] * -U[1][1], f, 1);
  R(e + V[0] * U[1][0], d - V[0] * -U[1][1], e, d + V[1], f);
  f = 3 == F ? 50 : 51;
  R(e - V[0] * U[1][0], d - V[0] * -U[1][1], e - V[1] * U[1][0], d - V[1] * -U[1][1], f, 1);
  R(e - V[0] * U[1][0], d - V[0] * -U[1][1], e + V[1] * -U[1][0], d + V[1] * -U[1][1], f, 1);
  R(e - V[0] * U[1][0], d - V[0] * -U[1][1], e, d + V[1], f, 1);
  f = 4 == F ? 50 : 51;
  R(e, d - V[1], e + V[2] * U[2][0], d - V[2] * U[2][1], f, 1);
  R(e, d - V[1], e, d - V[2], f);
  R(e, d - V[1], e - V[2] * U[2][0], d - V[2] * U[2][1], f, 1);
  f = 5 == F ? 50 : 51;
  R(e + V[1] * U[1][0], d - V[1] * U[1][1], e + V[2], d, f, 1);
  R(e + V[1] * U[1][0], d - V[1] * U[1][1], e + V[2] * U[1][0], d - V[2] * U[1][1], f, 1);
  R(e + V[1] * U[1][0], d - V[1] * U[1][1], e + V[2] * U[2][0], d - V[2] * U[2][1], f, 1);
  f = 9 == F ? 50 : 51;
  R(e - V[1] * U[1][0], d - V[1] * U[1][1], e - V[2], d, f);
  R(e - V[1] * U[1][0], d - V[1] * U[1][1], e - V[2] * U[1][0], d - V[2] * U[1][1], f, 1);
  R(e - V[1] * U[1][0], d - V[1] * U[1][1], e - V[2] * U[2][0], d - V[2] * U[2][1], f, 1);
  f = 7 == F ? 50 : 51;
  R(e, d + V[1], e + V[2] * U[2][0], d + V[2] * U[2][1], f, 1);
  R(e, d + V[1], e, d + V[2], f, 1);
  R(e, d + V[1], e - V[2] * U[2][0], d + V[2] * U[2][1], f, 1);
  f = 6 == F ? 50 : 51;
  R(e + V[1] * U[1][0], d + V[1] * U[1][1], e + V[2], d, f, 1);
  R(e + V[1] * U[1][0], d + V[1] * U[1][1], e + V[2] * U[1][0], d + V[2] * U[1][1], f, 1);
  R(e + V[1] * U[1][0], d + V[1] * U[1][1], e + V[2] * U[2][0], d + V[2] * U[2][1], f, 1);
  f = 8 == F ? 50 : 51;
  R(e - V[1] * U[1][0], d + V[1] * U[1][1], e - V[2], d, f, 1);
  R(e - V[1] * U[1][0], d + V[1] * U[1][1], e - V[2] * U[1][0], d + V[2] * U[1][1], f, 1);
  R(e - V[1] * U[1][0], d + V[1] * U[1][1], e - V[2] * U[2][0], d + V[2] * U[2][1], f, 1);
  Y(P[0][0], 0, S[0][0], S[0][1], T, T, 0);
  Y(P[0][1], 0, S[1][0], S[1][1], T, T, 1);
  Y(P[0][2], 2 * Math.PI / 3, S[2][0], S[2][1], T, T, 2);
  Y(P[0][3], 4 * Math.PI / 3, S[3][0], S[3][1], T, T, 3);
  Y(P[0][4], 0, S[4][0], S[4][1], 1.5 * T, 1.5 * T, 4);
  Y(P[0][5], Math.PI / 3, S[5][0], S[5][1], 1.5 * T, 1.5 * T, 5);
  Y(P[0][6], 2 * Math.PI / 3, S[6][0], S[6][1], 1.5 * T, 1.5 * T, 6);
  Y(P[0][7], Math.PI, S[7][0], S[7][1], 1.5 * T, 1.5 * T, 7);
  Y(P[0][8], 4 * Math.PI / 3, S[8][0], S[8][1], 1.5 * T, 1.5 * T, 8);
  Y(P[0][9], 5 * Math.PI / 3, S[9][0], S[9][1], 1.5 * T, 1.5 * T, 9);
  Y(P[0][10], 0, S[10][0], S[10][1], 2 * T, 2 * T, 10);
  Y(P[0][11], Math.PI / 6, S[11][0], S[11][1], 2 * T, 2 * T, 11);
  Y(P[0][12], Math.PI / 3, S[12][0], S[12][1], 2 * T, 2 * T, 12);
  Y(P[0][13], Math.PI / 2, S[13][0], S[13][1], 2 * T, 2 * T, 13);
  Y(P[0][14], 2 * Math.PI / 3, S[14][0], S[14][1], 2 * T, 2 * T, 14);
  Y(P[0][15], 5 * Math.PI / 6, S[15][0], S[15][1], 2 * T, 2 * T, 15);
  Y(P[0][16], Math.PI, S[16][0], S[16][1], 2 * T, 2 * T, 16);
  Y(P[0][17], 7 * Math.PI / 6, S[17][0], S[17][1], 2 * T, 2 * T, 17);
  Y(P[0][18], 4 * Math.PI / 3, S[18][0], S[18][1], 2 * T, 2 * T, 18);
  Y(P[0][19], 3 * Math.PI / 2, S[19][0], S[19][1], 2 * T, 2 * T, 19);
  Y(P[0][20], 5 * Math.PI / 3, S[20][0], S[20][1], 2 * T, 2 * T, 20);
  Y(P[0][21], 11 * Math.PI / 6, S[21][0], S[21][1], 2 * T, 2 * T, 21);
  if ( - 1 != mf) {
    e = S;
    f = mf;
    lf("#e60000", e[f][0], e[f][1], 4 > f ? 25 : 10 > f ? 30 : 35);
    var e = a / 2 + a / 20,
    d = d - 2 * b,
    g = .4 * a,
    a = nf,
    h = of,
    f = mf;
    ze.g(e, d, g, 4 * b);
    k.fillStyle = "#EE1111";
    k.font = a + "px xirod";
    k.fillText(Gb[f], e + g / 2 - k.measureText(Gb[f]).width / 2, d + 1.5 * a);
    k.fillStyle = "#333";
    k.font = a + "px xirod";
    k.fillText("Abilities", e + g / 2 - k.measureText("Abilities").width / 2, d + 4.5 * a);
    k.font = h + "px xirod";
    b = Db[f];
    k.fillText(yb[b[0]], e + g / 2 - k.measureText(yb[b[0]]).width / 2, d + 6.5 * a);
    k.fillText(yb[b[1]], e + g / 2 - k.measureText(yb[b[1]]).width / 2, d + 7.5 * a);
    k.fillText(yb[b[2]], e + g / 2 - k.measureText(yb[b[2]]).width / 2, d + 8.5 * a);
    b = Fb[F];
    qf = b[0] == f || b[1] == f || b[2] == f ? !0 : !1;
    k.fillStyle = qf ? "#33ff33": "#EE1111";
    rf = qf ? "Upgrade": "Not Available";
    qf ? (b = 3 * J / 4 - k.measureText(rf).width / 2 - 10, e = K - .2 * K - a, d = k.measureText(rf).width + 10, a += 10, k.drawImage(Od, b, e, 10, a), k.drawImage(Pd, b + 10, e, d - 10, a), k.drawImage(Qd, b + d, e, 10, a)) : (b = 3 * J / 4 - k.measureText(rf).width / 2 - 10, e = K - .2 * K - a, d = k.measureText(rf).width + 10, a += 10, k.drawImage(Ae, b, e, 10, a), k.drawImage(Be, b + 10, e, d - 10, a), k.drawImage(Ce, b + d, e, 10, a));
    k.fillText(rf, 3 * J / 4 - k.measureText(rf).width / 2, K - .2 * K)
  }
  k.strokeStyle = "#EE1111";
  k.lineWidth = 5;
  k.globalAlpha = .1;
  k.beginPath();
  k.moveTo(J - 45, 10);
  k.lineTo(J - 10, 45);
  k.stroke();
  k.lineWidth = 3;
  k.globalAlpha = .5;
  k.beginPath();
  k.moveTo(J - 45, 10);
  k.lineTo(J - 10, 45);
  k.stroke();
  k.lineWidth = 1;
  k.globalAlpha = 1;
  k.beginPath();
  k.moveTo(J - 45, 10);
  k.lineTo(J - 10, 45);
  k.stroke();
  k.strokeStyle = "#EE1111";
  k.lineWidth = 5;
  k.globalAlpha = .1;
  k.beginPath();
  k.moveTo(J - 10, 10);
  k.lineTo(J - 45, 45);
  k.stroke();
  k.lineWidth = 3;
  k.globalAlpha = .5;
  k.beginPath();
  k.moveTo(J - 10, 10);
  k.lineTo(J - 45, 45);
  k.stroke();
  k.lineWidth = 1;
  k.globalAlpha = 1;
  k.beginPath();
  k.moveTo(J - 10, 10);
  k.lineTo(J - 45, 45);
  k.stroke()
}
function Y(a, b, e, d, f, g, h) {
  k.globalAlpha = -1 == Fb[F].indexOf(h) ? .5 : 1;
  A(k, a, b, e, d, f, g);
  k.globalAlpha = 1
}
var qf, rf, sf = !1;
function tf() {
  var a = K - 210,
  b = bd,
  e = cd;
  k.drawImage(re, 20, a, 190, 190); - 1 != b && -1 != e && Math.pow(b - 115, 2) + Math.pow(e - (a + 95), 2) < Math.pow(95, 2) ? (k.drawImage(se, b - 47.5, e - 47.5, 95, 95), sf = !0) : (k.drawImage(se, 67.5, a + 95 - 47.5, 95, 95), sf = !1)
}
function uf() {
  var a, b;
  a = J / 20;
  b = J / 20;
  k.drawImage(ee[3], 75 * J / 100 - a / 2, 9 * K / 10 - b / 2, a, b)
}
function vf() {
  var a = J / 20,
  b = J / 20,
  e = 75 * J / 100,
  d = 9 * K / 10;
  ze.g(e - a / 2 - 5, d - 11 * b - 5, a + 10, 10 * b + 10);
  for (var f = 0; f < ee.length; f++) k.drawImage(ee[f], e - a / 2, d - 11 * b + f * b - 1, a, b)
}
var wf = document.getElementById("shipOrganization");
wf.onchange = function() {
  nc = wf.selectedIndex;
  Oe()
};
var xf = document.getElementById("buyButton"),
yf = document.getElementById("equipButton");
xf.onclick = function() {
  var a = mc;
  if (null != u && x) {
    var b = new ArrayBuffer(5),
    e = new DataView(b);
    e.setUint8(0, 21);
    e.setInt32(1, a);
    u.send(b)
  }
};
yf.onclick = function() {
  var a = mc;
  if (null != u && x) {
    var b = new ArrayBuffer(5),
    e = new DataView(b);
    e.setUint8(0, 22);
    e.setInt32(1, a);
    u.send(b)
  }
};
guiItem = document.getElementById("shopElement1");
var zf = document.getElementById("elementParent");
document.getElementById("featuredTab").onclick = function() {
  Oe(0)
};
document.getElementById("trailTab").onclick = function() {
  Oe(1)
};
document.getElementById("tagTab").onclick = function() {
  Oe(2)
};
document.getElementById("skinTab").onclick = function() {
  Oe(3)
};
IsMobile || (document.getElementById("creditsTab").onclick = function() {
  Oe(4)
});
function Oe(a) {
  a = null != a ? a: oc;
  for (wf.style.display = 3 == a ? "": "none"; 1 < zf.childElementCount;) zf.removeChild(zf.lastChild);
  oc = a;
  var b = 0,
  e = 0;
  xf.style.display = yf.style.display = "none";
  for (var d in Vb) Vb[d].style.display = "none";
  for (d in lc) {
    var f = lc[d];
    if (! (f.type != a || 3 == a && f.h != nc || 0 > f.G && !Cd[f.id])) {
      e++;
      var g = guiItem.cloneNode(!0);
      0 > v && (v = " ");
      var h = f.id == vc || f.id == wc || f.id == xc || f.id == yc[nc],
      v = f.G;
      Cd[f.id] && (g.style.background = "url('UIAssets/ShopWindow_EQUIPPED.png')", v = " ", h && (v = "equipped"));
      g.style.display = "inline-block";
      if (0 == a || 3 == a) {
        if (!H[f.id][1]) continue;
        g.childNodes[1].src = H[f.id][1].src
      } else g.childNodes[1].src = H[f.id] ? H[f.id].src: f.V;
      g.childNodes[3].innerHTML = f.name + "</br>" + v + "</br>";
      if (3 == a) {
        b = g.childNodes[1];
        b.style.visibility = "hidden";
        var m = document.createElement("div");
        m.style.position = "relative";
        m.style.width = "0px";
        m.style.height = "0px";
        g.appendChild(m);
        var q = new Image(b.width, b.height),
        b = new Image(b.width, b.height);
        q.src = P[1][nc].src;
        b.src = H[f.id][1].src;
        m.appendChild(q);
        m.appendChild(b);
        b.style.position = q.style.position = "absolute";
        b.style.top = q.style.top = "-120px";
        b.style.left = q.style.left = "37px"
      }
      if (f.id == mc) for (d in g.style.background = "url('UIAssets/ShopWindow_PURCHASED.png')", 0 <= mc && (Cd[mc] ? (yf.style.display = "", xf.style.display = "none", yf.textContent = h ? "UnEquip": "Equip") : (yf.style.display = "none", xf.style.display = 0 <= f.G ? "": "none")), Vb) Vb[d].style.display = d == f.id ? "": "none";
      h && (g.style.background = "url('UIAssets/ShopWindow_PURCHASEDv2.png')");
      g.onclick = function(a) {
        return function() {
          mc = a;
          Oe()
        }
      } (f.id);
      zf.appendChild(g);
      b = g.offsetWidth
    }
  }
  zf.style.width = 10 + Math.ceil(e / 2) * (b + 10) + "px"
}
Oe(lc);
function Ke() {
  var a = c.width;
  c.height > a && (a = c.height);
  Xc = a / sd
}
function Af(a) {
  c.width = aa.width = ca.width = ea.width = l.width = window.innerWidth;
  c.height = aa.height = ca.height = ea.height = l.height = window.innerHeight;
  Ke();
  1 != a && render()
}
function Bf(a) {
  IsMobile || (null != a && (pc = a.clientX, qc = a.clientY), mouseWorldPosX = (pc - window.innerWidth / 2) / Xc + playerX, mouseWorldPosY = (qc - window.innerHeight / 2) / Xc + playerY, null == Z && (selfAngle = Math.atan2(qc - window.innerHeight / 2, pc - window.innerWidth / 2)))
}
function Cf() {
  if (!IsMobile) if (Gc) {
    var a = Df(mouseWorldPosX, mouseWorldPosY, 2);
    if (null != a) {
      var b = entities[a];
      if (1E4 > Xd(b.a, b.b, mouseWorldPosX, mouseWorldPosY)) {
        Hc = a;
        return
      }
    }
    Hc = null
  } else if (gc && vd) gc = !1;
  else {
    a = !1;
    for (b in jc) {
      var e = jc[b];
      if (nb(e) && Yc) {
        a = !0;
        e.action();
        break
      }
    }
    b = pc / I;
    if (qc / I > K - 80) for (t = 0; 4 > t; t++) if (e = J / 2 - 138 + 80 * t, b > e && b < e + 36 && 7 > Ib[t] && scrap >= Jb(t)) {
      3 > t ? kd(t) : fd();
      a = !0;
      break
    }
    a || Yc || (Ec = firing = !0)
  }
}
function Ef() {
  if (!IsMobile) if (gc && vd) gc = !1;
  else {
    var a = !1,
    b;
    for (b in jc) if (nb(jc[b])) {
      a = !0;
      break
    }
    if (qc / I > K - 80) for (t = 0; 4 > t; t++) if (b = J / 2 - 138 + 80 * t, pc / I > b && pc / I < b + 36 && 4 > Ib[t] && scrap >= Jb(t)) {
      a = !0;
      break
    }
    b = Date.now(); ! a && !Yc && b > zc && 0 <= zc && scrap >= Eb[F] && (Bc = !0, Cc = [mouseWorldPosX, mouseWorldPosY])
  }
}
function Ff(a) {
  if (!IsMobile) {
    a = a.keyCode;
    if (48 <= a && 57 >= a) Gf(a - 48);
    else if (81 == a || 85 == a) kd(0);
    else if (87 == a || 73 == a) kd(1);
    else if (69 == a || 79 == a) kd(2);
    else if (82 == a || 80 == a) {
      var b = Jb(3);
      null != b && scrap >= b && fd()
    } else 65 == a ? Cf() : 83 == a ? Ef() : 27 == a ? Yc ? fd() : null != u && u.readyState == u.OPEN && (Jc = !0, b = new ArrayBuffer(1), (new DataView(b)).setUint8(0, 13), u.send(b), Ad + 9500 > Date.now() && Pe()) : 16 == a && (Ic = !0);
    Gc && Hc && 107 <= xc && 108 >= xc && (73 == a && (Hf(0), Hc = null), 80 == a && (Hf(1), Hc = null), 82 == a && Hf(2), 89 == a && Hf(3))
  }
}
function Hf(a) {
  var b = Hc,
  e = new ArrayBuffer(4),
  d = new DataView(e);
  d.setUint8(0, 24);
  d.setUint8(1, a);
  d.setInt16(2, b);
  u.send(e)
}
function Me() {
  Jc = !0;
  rc = document.getElementById("NameArea").value;
  localStorage.name = rc;
  var a = 0;
  document.getElementById("radioAuto").checked && (a = 2);
  document.getElementById("radioRed").checked && (a = 1);
  var b = new ArrayBuffer(2 * rc.length + 3),
  e = new DataView(b);
  e.setUint8(0, 4);
  e.setUint8(1, a);
  Ga(e, 2, rc);
  u.send(b)
}
var If = !1;
function Jf(a) {
  console.log("On close! ");
  console.log(a);
  If = !1;
  hd(!1);
  setTimeout(function() {
    Kf()
  },
  1E3)
}
function Lf() {
  If = !0;
  hd(!1);
  console.log("onopen");
  ha.style.display = "none";
  ia.style.display = "none";
  ua.style.display = "none";
  wa.style.display = "none";
  p.style.display = "none";
  ka.style.display = "";
  ka.innerHTML = "Loading.. 0%";
  if (Wc) {
    var a = new ArrayBuffer(2 + Wc.length),
    b = new DataView(a);
    b.setUint8(0, 23);
    Vd(b, 1, Wc);
    u.send(a)
  }
  localStorage.username && localStorage.hash && Da()
}
var Mf = [];
function Nf(a) {
  var b = Date.now(),
  e = !1,
  d = new WebSocket("ws://" + $b[a] + ":55665");
  d.binaryType = "arraybuffer";
  d.onerror = d.onclose = function() {
    if (!e) {
      console.log($b[a] + " ping: " + (Date.now() - b));
      var d = new Option;
      d.value = a;
      var g = new Text;
      g.textContent = Zb[a];
      d.appendChild(g);
      p.appendChild(d); - 1 == chosenServer && (chosenServer = a, p.selectedIndex = a, setTimeout(Kf, 3E3));
      Mf.push(a)
    }
  };
  d.onerror = function() {
    console.log("Couldn't connect to " + $b[a] + "!");
    e = !0
  }
}
function Kf() {
  if (!If) if (ha.style.display = "none", ia.style.display = "none", ua.style.display = "none", wa.style.display = "none", p.style.display = "none", ka.style.display = "inline", ka.innerHTML = "Connecting..", Ec = firing = vd = !1, selfHealth = selfMaxHealth = 100, La(!0), wd = [], vb = [0, 0, 0], scrap = Kb = F = 0, selfMoveSpeed = 300, 0 > chosenServer && !url) {
    for (console.log("Scanning servers"); p.hasChildNodes();) p.removeChild(p.lastChild);
    for (var a = 0; a < $b.length; a++) setTimeout(Nf, 0, a)
  } else qa()
}
function qa() {
  null != u && (u.onopen = null, u.onmessage = null, u.onclose = null, u.close(), u = null);
  console.log("Connecting to " + (url || $b[chosenServer] + ":55666"));
  u = new WebSocket("ws://" + (url || $b[chosenServer] + ":55666"));
  u.binaryType = "arraybuffer";
  u.onopen = Lf;
  u.onmessage = Qe;
  u.onclose = Jf;
  u.onerror = function(a) {
    console.log("The following error occurred: " + a.data);
    Pc++;
    if (2 == Pc) {
      a = null;
      for (var b in p.children) if (p.children[b].value == chosenServer) {
        a = p.children[b];
        break
      }
      p.removeChild(a);
      Mf.splice(0, 1);
      chosenServer = Mf[0];
      Pc = 0
    }
  }
}
function Qa(a) {
  if (null != u && null == pb[a]) {
    var b = new ArrayBuffer(3),
    e = new DataView(b);
    e.setUint8(0, 6);
    e.setUint16(1, a);
    u.send(b);
    pb[a] = ""
  }
}
function Le(a) {
  scraps = [];
  turrets = [];
  controlPoints = [];
  drones = [];
  players = [];
  missiles = [];
  wd = [];
  vb = [0, 0, 0];
  Kb = F = 0;
  selfHealth = selfMaxHealth = 100;
  scrap = 0;
  sd = 1800;
  Ke();
  Lb = 0;
  Bc = !1;
  Oc = soccerBall = null;
  Sc = -1;
  a && (pb = [], Hd = Gd = 0)
}
function Of(a) {
  null != a && 1 >= a && entities[a].update();
  var b, e;
  if (null == a || null != entities[a]) {
    var d;
    e = [playerX, playerY];
    d = selfAngle;
    b = selfFiringRange;
    var f = 20;
    null == a ? b = [e[0] + b * Math.cos(d), e[1] + b * Math.sin(d)] : (f = entities[a].l, b = [entities[a].a, entities[a].b]);
    Ne(e[0], e[1], b[0], b[1], null != a || void 0, f, 0, Kb)
  }
}
function Ne(a, b, e, d, f, g, h, v) {
  g = g || 20;
  e += z( - g, g);
  d += z( - g, g);
  ic.push([[a, b], [e, d], Date.now(), h, v]);
  f && Za(e, d, 0, 400, 30, 0);
  a = Math.sqrt((a - playerX) * (a - playerX) + (b - playerY) * (b - playerY));
  e = Math.sqrt((e - playerX) * (e - playerX) + (d - playerY) * (d - playerY));
  $a("shots", .2 * Math.min(Je(a < e ? a: e), .8))
}
function Je(a, b) {
  var e = null == b ? a: Math.sqrt((a - playerX) * (a - playerX) + (b - playerY) * (b - playerY));
  if (isNaN(e)) return 1E-4;
  e = .1 + .9 * (1 - e / (sd / 2));
  return 0 < e && 1 >= e ? e: 1E-4
}
function Za(a, b, e, d, f, g) {
  0 < g && (a += db( - g, g), b += db( - g, g));
  g = Date.now();
  $c.push([a, b, g + e, g + d, f, z(0, 8), 2 * Math.random() * y, db( - .08, .08)])
}
function Pf() {
  if (vd && !(0 >= selfHealth)) {
    Bf(null);
    APIHook();
    var a = Date.now();
    if (null != u && u.readyState == u.OPEN) {
      var b = !1;
      if (sc || hackAutoFire) var b = Qf(),
      e = b[0],
      b = b[1] < selfFiringRange * selfFiringRange && null != e;
      if (0 <= scrap && (null != Z && Z.buttons[7].pressed || firing || Ec || b || hackAutoFire) && a > Dc + hackFireRate) {
        if (null != u && u.readyState == u.OPEN) {
          e = Qf();
          b = e[0];
          if (e[1] < selfFiringRange * selfFiringRange && null != b) {
            shot = !0;
            Of(b);
            var e = new ArrayBuffer(7),
            d = new DataView(e);
            d.setUint8(0, 9);
            d.setUint16(1, b);
            d.setUint16(3, playerX);
            d.setUint16(5, playerY);
            u.send(e)
          } else e = new ArrayBuffer(5),
          d = new DataView(e),
          d.setUint8(0, 10),
          d.setUint16(1, playerX),
          d.setUint16(3, playerY),
          u.send(e),
          Of(null);
          Fc = Date.now() + 350
        }
        Dc = a
      } else Dd != playerX || Ed != playerY ? (a = new ArrayBuffer(5), b = new DataView(a), b.setUint8(0, 0), b.setUint16(1, playerX), b.setUint16(3, playerY), u.send(a), Dd = playerX, Ed = playerY) : Fd != selfAngle && (a = new ArrayBuffer(2), b = new DataView(a), b.setUint8(0, 3), b.setUint8(1, selfAngle % (2 * y) * Nd), u.send(a), Fd = selfAngle);
      Bc && (Bc = !1, selfDrones != selfMaxDrones && null != u && u.readyState == u.OPEN && (a = Db[F][0], b = sb[a], null == b ? (b = new ArrayBuffer(5), e = new DataView(b), e.setUint8(0, 7), e.setInt16(1, Cc[0]), e.setInt16(3, Cc[1]), u.send(b), zc = -100) : (d = Df(Cc[0], Cc[1], b), null != d && (b = new ArrayBuffer(3), e = new DataView(b), e.setUint8(0, 8), e.setInt16(1, d), u.send(b), zc = -100)), (a = rb[a]) && a()))
    }
    Ec = !1
  }
}
function kd(a, b) {
  Yc && 3 > a && (b = a, a = 3);
  if (null != u && u.readyState == u.OPEN) {
    var e = new ArrayBuffer(2 + (null != b ? 1 : 0)),
    d = new DataView(e);
    d.setUint8(0, 1);
    d.setUint8(1, a);
    3 == a && null != b && (d.setUint8(2, b), Yc = !1, gd.visible = Yc);
    u.send(e)
  }
}
function Gf(a) {
  if (null != u && u.readyState == u.OPEN) {
    var b = new ArrayBuffer(2),
    e = new DataView(b);
    e.setUint8(0, 14);
    e.setUint8(1, a);
    u.send(b);
    ad.push([null, a, Date.now()])
  }
}
function Rf() {
  try {
    if (null != u && u.readyState == u.OPEN) {
      var a = new ArrayBuffer(1); (new DataView(a)).setUint8(0, 5);
      u.send(a);
      Uc = Date.now()
    }
  } catch(b) {}
}
function bb(a) {
  var b = od + (Date.now() - pd) / rd;
  1 == a && (b += y);
  return [td / 2 + Math.cos(b) * qd, ud / 2 + Math.sin(b) * qd, b]
}
render = function() {
  try {
    var a = Date.now(),
    b = a - Jd;
    Jd = a;
    // HACK: FPS tracking
    hackFPSFrames++;
    if (a - hackFPSTimer >= 1000) { hackFPSValue = hackFPSFrames; hackFPSFrames = 0; hackFPSTimer = a; }
    Id && (G = Xc);
    if (c.width != window.innerWidth || c.height != window.innerHeight) c.width = aa.width = ca.width = ea.width = l.width = window.innerWidth,
    c.height = aa.height = ca.height = ea.height = l.height = window.innerHeight,
    Ke();
    k.clearRect(0, 0, c.width, c.height);
    k.save();
    G = (4 * G + Xc) / 5;
    var hackRenderG = G * hackZoom; // zoom only affects world, not UI
    B = c.width / hackRenderG;
    E = c.height / hackRenderG;
    var e = .125 * -playerX % Na.naturalWidth,
    d = .125 * -playerY % Na.naturalHeight;
    ba.translate(e, d);
    ba.fillStyle = De;
    ba.fillRect( - e, -d, c.width, c.height);
    ba.translate( - e, -d);
    k.scale(hackRenderG, hackRenderG);
    var e = playerX - B / 2,
    d = playerY - E / 2,
    f = Kd[0] - playerX,
    g = Kd[1] - playerY;
    Kd = [playerX, playerY];
    Ld = !Ld;
    var h = da,
    v = ca,
    m = fa;
    Ld && (h = fa, v = ea, m = da);
    m.globalAlpha = .97;
    m.globalCompositeOperation = "source-over";
    m.drawImage(v, f * Xc, g * Xc);
    h.clearRect(0, 0, c.width, c.height);
    if (!Gc && 0 < selfHealth && 0 <= wc) Nb[wc](m, a, null);
    Rb++;
    m.globalCompositeOperation = "source-over";
    m.save();
    m.scale(G, G);
    if (vd) {
      k.strokeStyle = "#AAAAAA";
      k.globalAlpha = .5;
      k.lineWidth = 2;
      af( - e, -d, td, ud);
      k.globalAlpha = 1;
      for (var q in scraps) scraps[q].g(e, d);
      for (f = 0; 2 > f; f++) {
        var w = bb(f);
        A(k, le[f], -w[2], w[0] - e, w[1] - d, 800, 800)
      } ! Gc && 0 < selfHealth && (k.globalAlpha = .2, k.lineWidth = 2, k.strokeStyle = "#77EEFF", k.beginPath(), k.arc(B / 2, E / 2, 80 * (1 + Bb[F]) / 2 - 20, 0, 2 * Math.PI), k.stroke(), k.globalAlpha = 1);
      k.strokeStyle = "#EFE4B0";
      k.globalAlpha = .4;
      k.lineWidth = 2;
      var icWrite = 0;
      for (var qi = 0; qi < ic.length; qi++) {
        var icq = ic[qi];
        if (!icq) continue;
        if (a <= icq[2] + 120) {
          k.globalAlpha = .4 + (icq[2] - a) / 120 * .4;
          k.beginPath();
          k.moveTo(icq[0][0] - e, icq[0][1] - d);
          k.lineTo(icq[1][0] - e, icq[1][1] - d);
          k.stroke();
          ic[icWrite++] = icq
        }
      }
      ic.length = icWrite;
      k.globalAlpha = 1;
      for (q in missiles) if (a > missiles[q][3]) {
        var D = entities[missiles[q][0]];
        if (D) for (f = 0; f < z(4, 8); f++) Za(D.a, D.b, z(0, 100), z(500, 900), z(35, 50), 30);
        delete missiles[q]
      } else {
        var C = missiles[q],
        L,
        oa,
        w = null;
        C[0] == selfID && (L = playerX, oa = playerY, w = selfTeam);
        if (D = entities[C[0]]) 2 > C[0] && D.update(),
        L = D.a,
        oa = D.b,
        w = D.c;
        null != L && (C[4] += (L - C[4]) * b / (C[3] - a), C[5] += (oa - C[5]) * b / (C[3] - a), A(k, droneImages[1 - w][4], Math.atan2(oa - C[5], L - C[4]) + y / 2, C[4] - e, C[5] - d, 45, 45))
      }
      k.font = "14px xirod";
      IsMobile && (k.font = K / 20 + "px xirod");
      k.fillStyle = "#77EEFF";
      soccerBall && soccerBall.g(e, d);
      k.globalAlpha = 1;
      for (q in turrets) turrets[q].g(e, d);
      for (q in controlPoints) controlPoints[q].g(e, d),
      Re(controlPoints[q].a - e, controlPoints[q].b - d - 120, controlPoints[q].i);
      for (q in drones) drones[q].C && drones[q].g(e, d);
      for (q in players) {
        var r = players[q];
        if (0 < r.i && 0 <= r.c && 1 >= r.c) {
          if (0 < r.m[1] && r.c == selfTeam) Nb[r.m[1]](m, a, r);
          var N = (Cb[r.h] + 1) / 2;
          Ra(r);
          Sa(r, r.a - e, r.b - d, N);
          k.globalAlpha = r.s[2] ? .3 : 1;
          A(k, P[r.c][r.h], r.f + y / 2, r.a - e, r.b - d, 100 * Bb[r.h], 100 * Bb[r.h]);
          0 < r.m[3] && A(k, H[r.m[3]][r.c], r.f + y / 2, r.a - e, r.b - d, 100 * Bb[r.h], 100 * Bb[r.h]);
          0 < r.m[0] && A(k, H[r.m[0]][r.c], r.f + y / 2, r.a - e, r.b - d, 100 * Bb[r.h], 100 * Bb[r.h]);
          k.globalAlpha = 1;
          Ya(r.a - e, r.b - d - 70 * N, r.i / r.u, N, r.u);
          k.fillStyle = tb[r.c];
          var Hb = pb[r.name];
          "" == Hb && (Hb = "[Unnamed]");
          k.fillText(Hb, r.a - e - k.measureText(Hb).width / 2, r.b - d - 74 * N);
          // HACK: lines from your ship to all players
          if (hackTracers) {
            var tIsEnemy = (r.c != selfTeam);
            var tColor = tb[r.c];
            var tx = r.a - e, ty = r.b - d;
            k.save();
            k.lineCap = "round";
            k.strokeStyle = tColor;
            if (!tIsEnemy) k.setLineDash([6 / hackRenderG, 8 / hackRenderG]);
            k.beginPath();
            k.moveTo(B / 2, E / 2);
            k.lineTo(tx, ty);
            // Pass 1 — wide outer glow
            k.lineWidth = 8 / hackRenderG;
            k.globalAlpha = tIsEnemy ? 0.08 : 0.05;
            k.stroke();
            // Pass 2 — medium glow
            k.lineWidth = 3.5 / hackRenderG;
            k.globalAlpha = tIsEnemy ? 0.25 : 0.15;
            k.stroke();
            // Pass 3 — sharp bright core
            k.lineWidth = 1.2 / hackRenderG;
            k.globalAlpha = tIsEnemy ? 0.75 : 0.5;
            k.stroke();
            k.setLineDash([]);
            k.restore();
          }
          // HACK: velocity tracking for LeadAim and PredictLine
          var hackNowVT = Date.now();
          if (hackLastPos[q]) {
            var hackDtVT = (hackNowVT - hackLastPos[q].t) / 1000;
            if (hackDtVT > 0 && hackDtVT < 0.25) {
              hackVelocities[q] = {
                vx: (r.a - hackLastPos[q].x) / hackDtVT,
                vy: (r.b - hackLastPos[q].y) / hackDtVT
              };
            }
          }
          hackLastPos[q] = { x: r.a, y: r.b, t: hackNowVT };
          // HACK: movement prediction line - dashed trail showing where enemy is headed
          if (hackPredictLine && hackVelocities[q]) {
            var hackPV = hackVelocities[q];
            var hackPSpeed = Math.sqrt(hackPV.vx * hackPV.vx + hackPV.vy * hackPV.vy);
            if (hackPSpeed > 25) {
              var hackPFactor = 0.5; // predict 500 ms forward
              var hackPex = r.a - e + hackPV.vx * hackPFactor;
              var hackPey = r.b - d + hackPV.vy * hackPFactor;
              k.save();
              k.strokeStyle = (r.c != selfTeam || FFA) ? "#FF8866" : "#88FF88";
              k.setLineDash([4 / hackRenderG, 4 / hackRenderG]);
              k.lineWidth = 1.5 / hackRenderG;
              k.globalAlpha = 0.65;
              k.beginPath();
              k.moveTo(r.a - e, r.b - d);
              k.lineTo(hackPex, hackPey);
              k.stroke();
              k.setLineDash([]);
              k.strokeStyle = (r.c != selfTeam || FFA) ? "#FF4422" : "#44FF44";
              k.lineWidth = 2 / hackRenderG;
              k.globalAlpha = 0.8;
              k.beginPath();
              k.arc(hackPex, hackPey, 9 / hackRenderG, 0, 2 * Math.PI);
              k.stroke();
              k.restore();
            }
          }
          // HACK: enemy distance label (world units, shown right of HP bar)
          if (hackEnemyDist) {
            var hackDistV = Math.round(Math.sqrt((r.a - playerX)*(r.a - playerX) + (r.b - playerY)*(r.b - playerY)));
            k.save();
            k.globalAlpha = 0.75;
            k.fillStyle = hackDistV < selfFiringRange ? "#FFCC44" : "#AAAAAA";
            k.font = (9 / hackRenderG) + "px xirod";
            k.fillText(hackDistV + "u", r.a - e + 55 * N, r.b - d - 74 * N + 4);
            k.restore();
          }
          0 < r.m[2] && A(k, H[r.m[2]], 0, r.a - e - k.measureText(Hb).width / 2 - 20, r.b - d - 74 * N - 10, 30, 30);
          Oc == q && A(k, ne, 0, r.a - e, r.b - d - 98 * N - 10, 30, 30)
        }
      }
      // HACK: off-screen ESP arrows - shows enemy/ally direction at viewport edge
      if (hackESPArrows) {
        var hackEspMargin = 20 / hackRenderG;
        var hackEspCx = B / 2, hackEspCy = E / 2;
        for (var hackEid in players) {
          var hackEp2 = players[hackEid];
          if (!hackEp2 || hackEp2.i <= 0) continue;
          var hackEpx = hackEp2.a - e, hackEpy = hackEp2.b - d;
          // Skip if on screen (with generous margin)
          if (hackEpx >= -40/hackRenderG && hackEpx <= B + 40/hackRenderG &&
              hackEpy >= -40/hackRenderG && hackEpy <= E + 40/hackRenderG) continue;
          var hackEdx = hackEpx - hackEspCx, hackEdy = hackEpy - hackEspCy;
          // Clamp to viewport edge
          var hackEscX = hackEdx !== 0 ? (hackEdx > 0 ? B - hackEspMargin - hackEspCx : hackEspMargin - hackEspCx) / hackEdx : Infinity;
          var hackEscY = hackEdy !== 0 ? (hackEdy > 0 ? E - hackEspMargin - hackEspCy : hackEspMargin - hackEspCy) / hackEdy : Infinity;
          var hackEsc  = Math.min(Math.abs(hackEscX), Math.abs(hackEscY));
          var hackEax  = hackEspCx + hackEdx * hackEsc;
          var hackEay  = hackEspCy + hackEdy * hackEsc;
          var hackEang = Math.atan2(hackEdy, hackEdx);
          var hackEIsEnemy = FFA || hackEp2.c != selfTeam;
          var hackEhp  = hackEp2.u > 0 ? Math.max(0, Math.min(1, hackEp2.i / hackEp2.u)) : 1;
          var hackEg   = Math.round(40 + hackEhp * 180);
          k.save();
          k.translate(hackEax, hackEay);
          k.rotate(hackEang);
          k.fillStyle   = hackEIsEnemy ? ("rgba(255," + hackEg + ",40,0.85)") : "rgba(40,210,255,0.80)";
          k.strokeStyle = "rgba(0,0,0,0.5)";
          var hackAs = 1 / hackRenderG;
          k.lineWidth = 0.7 * hackAs;
          k.beginPath();
          k.moveTo( 13*hackAs,   0         );
          k.lineTo( -7*hackAs,   7*hackAs  );
          k.lineTo( -3*hackAs,   0         );
          k.lineTo( -7*hackAs,  -7*hackAs  );
          k.closePath();
          k.fill(); k.stroke();
          // Tiny HP bar drawn below the arrow (unrotated)
          k.rotate(-hackEang);
          var hackBw = 16*hackAs, hackBh = 2.5*hackAs;
          k.fillStyle = "#222"; k.fillRect(-hackBw/2, 14*hackAs, hackBw, hackBh);
          k.fillStyle = hackEIsEnemy ? ("rgba(255," + hackEg + ",40,0.9)") : "#44CCFF";
          k.fillRect(-hackBw/2, 14*hackAs, hackBw * hackEhp, hackBh);
          k.restore();
        }
      }
      if (0 < selfHealth && !Gc) {
        var ub = Bb[F],
        N = (Cb[F] + 1) / 2;
        for (var wdKey in wd) Ta[wdKey](k, B / 2, E / 2, N);
        k.globalAlpha = wd[2] ? .3 : 1;
        A(k, P[selfTeam][F], selfAngle + y / 2, B / 2 + .5, E / 2 + .5, 100 * ub, 100 * ub);
        0 <= yc[F] && A(k, H[yc[F]][selfTeam], selfAngle + y / 2, B / 2 + .5, E / 2 + .5, 100 * ub, 100 * ub);
        0 <= vc && A(k, H[vc][selfTeam], selfAngle + y / 2, B / 2 + .5, E / 2 + .5, 100 * ub, 100 * ub);
        k.globalAlpha = 1;
        Ya(B / 2, E / 2 - 70 * N, selfHealth / selfMaxHealth, N, selfMaxHealth);
        k.fillStyle = tb[selfTeam];
        k.fillText(rc, B / 2 - k.measureText(rc).width / 2, E / 2 - 74 * N);
        0 <= xc && (L = Math.min(B / 2 - k.measureText(rc).width / 2 - 20, B / 2 - 70), A(k, H[xc], 0, L, E / 2 - 74 * N - 6, 30, 30));
        selfID == Oc && A(k, ne, 0, B / 2, E / 2 - 98 * N - 6, 30, 30);
        // HACK: firing range ring
        if (hackRangeRing) {
          k.beginPath();
          k.arc(B / 2 + .5, E / 2 + .5, selfFiringRange, 0, 2 * Math.PI);
          k.strokeStyle = "#77EEFF";
          k.lineWidth = 1;
          k.globalAlpha = 0.18;
          k.stroke();
          k.fillStyle = "#77EEFF";
          k.globalAlpha = 0.06;
          k.fill();
          k.globalAlpha = 1;
        }
      }
      for (q in drones) drones[q].C || drones[q].g(e, d);
      kf(b, e, d);
      k.font = "15px xirod";
      var scWrite = 0;
      for (var qi = 0; qi < $c.length; qi++) {
        var pa = $c[qi];
        if (!pa) continue;
        pa[6] += pa[7];
        k.globalAlpha = Wd(pa[2], a, pa[3]);
        A(k, oe[pa[5]], pa[6], pa[0] - e, pa[1] - d, pa[4], pa[4]);
        if (a < pa[3]) $c[scWrite++] = pa
      }
      $c.length = scWrite;
      k.globalAlpha = 1;
      Se(e, d);
      n.clearRect(0, 0, l.width, l.height);
      k.scale(1 / hackRenderG, 1 / hackRenderG);
      if (LOS) {
        b = .415 * sd;
        n.globalAlpha = 1;
        n.globalCompositeOperation = "source-over";
        n.fillStyle = "#000";
        n.fillRect(0, 0, l.width, l.height);
        n.globalCompositeOperation = "destination-out";
        n.scale(hackRenderG, hackRenderG);
        Ue(n, B / 2 + .5, E / 2 + .5, b);
        k.drawImage(l, 0, 0);
        n.clearRect(0, 0, l.width, l.height);
        D = [];
        for (q in players) r = players[q],
        0 < r.i && 0 <= r.c && 1 >= r.c && (r.v = Math.sqrt((r.a - playerX) * (r.a - playerX) + (r.b - playerY) * (r.b - playerY)), r.v > b - 50 * Bb[r.h] || D.push(r));
        D.sort(function(a, b) {
          return b.v - a.v
        });
        for (q in D) r = D[q],
        n.fillStyle = "#000",
        n.globalAlpha = r.c == selfTeam ? Math.min(1, Math.max((r.v - 200) / 100, 0)) : Math.min(1, Math.max((r.v - 35) / 100, 0)),
        n.globalCompositeOperation = "source-over",
        bf(Math.atan2(r.b - playerY, r.a - playerX), 50 * Bb[r.h] / r.v),
        n.globalAlpha = 1,
        n.lineCap = "round",
        n.strokeStyle = "#FFF",
        n.lineWidth = 120 * Bb[r.h],
        n.globalCompositeOperation = "destination-out",
        n.beginPath(),
        n.moveTo(B / 2 + .5, E / 2 + .5),
        n.lineTo(r.a - e, r.b - d),
        n.stroke(),
        k.drawImage(l, 0, 0),
        n.clearRect(0, 0, l.width, l.height);
        n.scale(1 / hackRenderG, 1 / hackRenderG)
      }
      if (permDopeMode || dopeMode && firing && 0 < selfHealth) n.globalAlpha = 1,
      k.globalAlpha = 1,
      n.globalCompositeOperation = "source-over",
      e = a / 300,
      n.fillStyle = "rgb(" + Math.floor(255 * Math.max(Math.sin(e), 0)) + "," + Math.floor(255 * Math.max(Math.sin(e + 2 * y / 3), 0)) + "," + Math.floor(255 * Math.max(Math.sin(e + 4 * y / 3), 0)) + ")",
      n.fillRect(0, 0, l.width, l.height),
      k.globalCompositeOperation = "difference",
      k.drawImage(l, 0, 0),
      k.globalCompositeOperation = "source-over";
      I = (G + 1) / 2;
      J = c.width / I;
      K = c.height / I;
      k.scale(I, I);
      a = Date.now();
      if (IsMobile) jf(a),
      0 <= zc || zc++,
      Ye(J - 170, 200, 250),
      tf(),
      Te(15, 58, 100, 100),
      Xe(),
      uf(),
      ed && vf(),
      gf(),
      k.drawImage(pe, 2, 0, 150, 55),
      k.fillStyle = "#000",
      k.font = "11px xirod",
      k.fillText("Scrap: " + scrap, 27, 32),
      dd && pf(),
      Ad + 9500 > a ? drawEndGameMobile() : uc = !1,
      gc ? drawTutorialMobile(k) : Kc + 8E3 > a && !uc && df();
      else {
        Gc || (k.drawImage(pe, -10, 2, 225, 82), k.fillStyle = "#000", k.font = "16px xirod", k.fillText("Scrap: " + scrap, 40, 50), 0 <= zc ? hf(a) : zc++, 0 < Eb[F] && (k.fillStyle = "#77EEFF", k.font = "10px xirod", k.fillText("Cost: ", J / 2 + 257, K - 47), k.globalAlpha = 1, k.fillStyle = scrap < Eb[F] ? "#EE1111": "#77EEFF", k.fillText("- " + Eb[F], J / 2 + 257 + k.measureText("Cost: ").width, K - 47)), k.fillStyle = "#eeeeee", k.font = "12px xirod", k.globalAlpha = 1, k.fillText(yb[Db[F][0]], J / 2 + 260, K - 25), k.globalAlpha = 1, 0 < selfDrones && (k.fillStyle = "#77EEFF", k.font = "10px xirod", k.fillText("Drones: ", J / 2 + 257, K - 59), selfDrones >= selfMaxDrones && (k.fillStyle = "#EE1111"), k.fillText(selfDrones + "/" + selfMaxDrones, J / 2 + 257 + k.measureText("Drones: ").width, K - 59)), ff());
        Te(10, K - 130, 120, 120);
        Gc && Hc && 107 <= xc && 108 >= xc && (k.fillStyle = "#FFF", k.font = "14px xirod", k.fillText("R : Jester Name", 10, K - 220), k.fillText("Y : Freeze", 10, K - 200), k.fillText("I : Kill", 10, K - 180), k.fillText("P : Kick", 10, K - 160));
        Ve();
        Ye(J - 210, 230, 240);
        0 < Sc && (k.fillStyle = "#77EEFF", k.font = "16px xirod", k.fillText("Rank: " + Sc, J - 105 - k.measureText("Rank: " + Sc).width / 2, 240));
        a < nd + 15E3 && (k.fillStyle = "#EE1111", k.font = "20px xirod", k.fillText(md, J / 2 - k.measureText(md).width / 2, 75));
        e = J / 5;
        k.drawImage(ee[5], e, K - 40, 40, 40);
        k.fillStyle = "#77EEFF";
        k.font = "10px xirod";
        if (mouseOverArea(e, K - 40, 40, 40, !0)) for (d = J / 40, f = 1; 11 > f; f++) k.drawImage(ee[f % 10], e - 11 * d / 2 + d * f, K - 80, d, d),
        k.fillText(f % 10, e - 11 * d / 2 + d * f - 2, K - 80);
        if (a < Gd && 18E6 > Gd - a) {
          k.fillStyle = "#EE1111";
          k.font = "14px xirod";
          var va = "Special mode in:";
          k.fillText(va, J - k.measureText(va).width - 10, 280);
          va = $d(Gd - a);
          k.fillText(va, J - k.measureText(va).width - 10, 294)
        } else a > Gd && a < Hd && 288E5 > Gd - a && (k.fillStyle = "#EE1111", k.font = "14px xirod", va = "Game mode ends in:", k.fillText(va, J - k.measureText(va).width - 10, 280), va = $d(Hd - a), k.fillText(va, J - k.measureText(va).width - 10, 294));
        Ad + 9500 > a && ef();
        // HACK: compact in-game HUD (top-left, safely below scrap bar which ends ~y=84)
        if (vd) {
          k.save();
          k.font = "10px xirod";
          // FPS at y=92 — just below the scrap bar image
          if (hackFPS) {
            var hackFPSColor = hackFPSValue >= 50 ? "#44FF88" : hackFPSValue >= 30 ? "#FFAA00" : "#FF3333";
            k.fillStyle = hackFPSColor;
            k.globalAlpha = 0.85;
            k.fillText("FPS: " + hackFPSValue, 8, 92);
          }
          // Threat meter at y=106
          if (hackThreatMeter) {
            var hackTCount = 0;
            for (var hackTid in players) {
              var hackTP = players[hackTid];
              if (!hackTP || hackTP.i <= 0) continue;
              if (!FFA && hackTP.c == selfTeam) continue;
              var hackTdx = hackTP.a - playerX, hackTdy = hackTP.b - playerY;
              if (hackTdx*hackTdx + hackTdy*hackTdy < selfFiringRange*selfFiringRange*2.25) hackTCount++;
            }
            var hackTColor = hackTCount === 0 ? "#44FF88" : hackTCount <= 2 ? "#FFAA00" : "#FF2222";
            k.fillStyle = hackTColor;
            k.globalAlpha = 0.85;
            k.fillText("THREAT: " + hackTCount, 8, 106);
          }
          // Active-mod pills starting at y=120, only showing enabled mods (faint, unobtrusive)
          var hackActives = [];
          if (hackAutoFire)    hackActives.push("AUTOFIRE");
          if (hackAutoAim)     hackActives.push("AUTOAIM");
          if (hackTracers)     hackActives.push("TRACERS");
          if (hackAutoScrap)   hackActives.push("AUTOSCRAP");
          if (hackESPArrows)   hackActives.push("ESP");
          if (hackPredictLine) hackActives.push("PREDICT");
          if (hackEnemyDist)   hackActives.push("DIST");
          if (hackHPNumbers)   hackActives.push("HP#");
          if (hackEnemyRadar)  hackActives.push("RADAR");
          if (hackRangeRing)   hackActives.push("RING");
          // BOT state pill — prepended so it's always first
          if (botEnabled) hackActives.unshift("BOT:" + botState);
          if (hackActives.length > 0) {
            k.font = "9px xirod";
            k.fillStyle = botEnabled ? "#FFCC44" : "#77EEFF";
            k.globalAlpha = botEnabled ? 0.75 : 0.35;
            for (var hi = 0; hi < hackActives.length; hi++) {
              k.fillText("● " + hackActives[hi], 8, 120 + hi * 11);
            }
          }
          k.globalAlpha = 1;
          k.restore();
        }
        gc ? (k.fillStyle = "#444", k.globalAlpha = .85, k.fillRect(0, 0, J, K), k.globalAlpha = 1, k.fillStyle = "#77EEFF", k.font = "20px xirod", k.fillText("Scrap", 130, 60), k.fillStyle = "#CCC", k.font = "12px xirod", k.fillText("Collect scrap from around space", 5, 75), k.fillText("Or by killing other ships", 47, 90), k.fillText("Then upgrade your ship!", 49, 105), k.drawImage(Wa[1], 150, 120, 50, 50), k.lineWidth = 4, k.strokeStyle = "#77CCDD", k.beginPath(), k.arc(175, 145, 35, 0, 2 * Math.PI), k.stroke(), cf(), k.fillStyle = "#77EEFF", k.font = "20px xirod", k.fillText("Leaderboard", J - 240, 265), k.fillStyle = "#CCC", k.font = "12px xirod", af(J - 207, 2, 205, 240), k.fillText("The leaderboard shows", J - 250, 285), k.fillText("the 10 players with the", J - 246, 300), k.fillText("most kills and assists", J - 242, 315), k.fillStyle = "#77EEFF", k.font = "20px xirod", $e("Upgrade your ship", J / 2, K - 120), k.fillStyle = "#CCC", k.font = "12px xirod", $e("You can use hotkeys, or click to upgrade", J / 2, K - 105), $e("U,I,O and P also work, for left-handed users", J / 2, K - 90), af(J / 2 - 160, K - 82, 320, 80), k.fillStyle = "#77EEFF", k.font = "20px xirod", $e("Fire                    Ability", J / 2 + 22, K / 2), $e(" Or                         or ", J / 2 + 7, K / 2 + 20), $e(" A                            S  ", J / 2 + 10, K / 2 + 40), k.drawImage(qe, J / 2 - 50, K / 2 - 27, 100, 100), k.beginPath(), k.moveTo(J / 2 - 75, K / 2 - 7), k.lineTo(J / 2 - 15, K / 2 - 7), k.moveTo(J / 2 + 75, K / 2 - 7), k.lineTo(J / 2 + 20, K / 2 - 7), k.stroke(), k.fillStyle = "#77EEFF", k.font = "20px xirod", k.fillText("Ability cooldown", J / 2 + 247, K - 50), af(J / 2 + 242, K - 38, 165, 36), k.fillStyle = "#CCC", k.font = "12px xirod", $e("You can't use your ability", J / 2 + 545, K - 23), $e("until it's ready", J / 2 + 545, K - 8), k.font = "30px xirod", k.fillStyle = "#FFF", $e("Click to Continue...", J / 2, 120), k.fillStyle = "#77EEFF", k.font = "20px xirod", $e("Destroy the enemy base to win", J / 2, 200)) : Kc + 8E3 > a && df()
      }
      k.scale(1 / I, 1 / I);
      k.scale(hackRenderG, hackRenderG);
      Yc && 100 < B && 100 < E && Ze();
      k.scale(1 / hackRenderG, 1 / hackRenderG)
    }
    k.restore();
    m.restore();
    Id = !1
  } catch(Wf) {
    console.log(Wf.stack)
  }
};
MobileMoveDirection = function(a) {
  firing && (sc = !0);
  selfAngle = a
};
MobileStop = function() {
  sc = !1
};
MobileUseAbility = function() {
  Ef()
};
MobileClickDown = function(a, b, e, d, f) {
  a = a / f * screen.width;
  b = b / d * screen.height;
  a = a / screen.width * J;
  b = b / screen.height * K;
  gc && vd && (gc = !1);
  if (dd) {
    a > J - 35 && a < J - 5 && 5 < b && 35 > b && (dd = !1, mf = -1);
    e = a;
    d = b;
    for (f = 0; f < S.length; f++) e > S[f][0] - (3 > f ? T / 2 : 10 > f ? T / 2 * 1.5 : T) && e < S[f][0] + (3 > f ? T / 2 : 10 > f ? T / 2 * 1.5 : T) && d > S[f][1] - (3 > f ? T / 2 : 10 > f ? T / 2 * 1.5 : T) && d < S[f][1] + (3 > f ? T / 2 : 10 > f ? T / 2 * 1.5 : T) && (mf = mf == f ? -1 : f);
    qf && a > 3 * J / 4 - k.measureText(rf).width / 2 - 10 && a < 3 * J / 4 - k.measureText(rf).width / 2 - 10 + k.measureText(rf).width + 10 && b > K - .2 * K - nf && b < K - .2 * K - nf + nf + 10 && -1 != mf && (a = Fb[F].indexOf(mf), null != u && u.readyState == u.OPEN && (b = new ArrayBuffer(2 + (null != a ? 1 : 0)), e = new DataView(b), e.setUint8(0, 1), e.setUint8(1, 3), null != a && (e.setUint8(2, a), Yc = !1, gd.visible = Yc), u.send(b)), mf = -1, dd = !1)
  } else {
    d = a;
    f = b;
    for (var g = 0; 4 > g; g++) {
      var h = 80 * g,
      v = Jb(g);
      if (null != v && scrap >= v && d >= J / 2 - 160 + h && d <= J / 2 - 160 + h + 80 && f >= K - 40 + -67 && f < K - 40 + 33) {
        3 > g ? kd(g) : dd = !0;
        break
      }
    }
    d = a;
    f = b;
    var g = J / 20,
    h = J / 20,
    v = 75 * J / 100,
    m = 9 * K / 10;
    d > v - g / 2 && d < v + g / 2 && f > m - h / 2 && f < m + h / 2 && (ed = ed ? !1 : !0);
    if (ed) for (var q = 0; q < ee.length; q++) if (d > v - g / 2 && d < v + g / 2 && f > m - 11 * h + q * h - 1 && f < m - 11 * h + q * h - 1 + h) {
      Gf(q);
      ed = !1;
      break
    }
    d = J - 145;
    f = K - 135;
    a > d && a < d + 100 && b > f && b < f + 100 && !Bc && (Bc = !0, Cc = [playerX, playerY]);
    tc.push(e);
    uc && checkFacebookShareClick(a, b)
  }
};
MobileClickUp = function(a, b, e) {
  dd || -1 == tc.indexOf(e) || (tc.splice(tc.indexOf(e), 1), cd = bd = -1, MobileStop())
};
console.log("###### Version: 15 ######");
MobileClickMove = function(a, b, e, d, f) {
  a = a / f * screen.width;
  b = b / d * screen.height;
  a = a / screen.width * J;
  b = b / screen.height * K;
  e = 95 - a;
  d = K - 95 - b;
  f = Math.sqrt(e * e + d * d);
  dd || (bd = a, cd = b, 15 < f && 110 > f && MobileMoveDirection(Math.atan2( - d, -e)));
  vd || (a = Sf - bd, null !== document.getElementById("shopContentPanel") && (document.getElementById("shopContentPanel").scrollLeft += a), Sf = bd)
};
var Sf = 0;
function Df(a, b, e) {
  var d = 9999999999,
  f = null,
  g;
  for (g in players) {
    var h = players[g],
    v = Xd(h.a, h.b, a, b);
    0 < h.i && v < d && (0 == e && (h.c != selfTeam || FFA) || 1 == e && h.c == selfTeam || 2 == e) && (d = v, f = g)
  }
  return f
}
function Tf(a, b, e) {
  var d = Xd(e.a, e.b, playerX, playerY);
  if (Yd(Math.atan2(e.b - playerY, e.a - playerX), a) < b || 3600 >= d) if (e.c != selfTeam || FFA) return d;
  return null
}
function Qf() {
  var a = selfAngle,
  b = 9999999999,
  e = null,
  d;
  for (d in players) {
    var f = players[d];
    0 >= f.i || (f = Tf(a, .35, f)) && f < b && (b = f, e = d)
  }
  soccerBall && (f = Tf(a, .7, soccerBall)) && f < b && (b = f, e = soccerBallID);
  for (d in turrets)(f = Tf(a, .35, turrets[d])) && f < b && (b = f, e = d);
  for (d in controlPoints)(f = Tf(a, .35, controlPoints[d])) && f < b && (b = f, e = d);
  d = bb(1 - selfTeam);
  Yd(Math.atan2(d[1] - playerY, d[0] - playerX), a) < .35 * 3 && (f = Xd(d[0], d[1], playerX, playerY), f - 1E3 < b && (b = f, e = 1 - selfTeam));
  return [e, b]
}
function Uf() {
  var a = Date.now(),
  b = (a - Md) / 1E3;
  Md = a;
  if ("getGamepads" in navigator) if (Oa) {
    gamepads = navigator.getGamepads();
    null != Z && (Z.buttons[6].pressed && !Vf[4] && (Ef(), Cc = [playerX, playerY]), Z.buttons[2].pressed && !Vf[0] ? Ff({
      keyCode: 81
    }) : Z.buttons[0].pressed && !Vf[1] ? Ff({
      keyCode: 87
    }) : Z.buttons[1].pressed && !Vf[2] ? Ff({
      keyCode: 69
    }) : Z.buttons[3].pressed && !Vf[3] && Ff({
      keyCode: 82
    }), Vf = [Z.buttons[2].pressed, Z.buttons[0].pressed, Z.buttons[1].pressed, Z.buttons[3].pressed, Z.buttons[6].pressed]);
    firing && (Z = null);
    for (var e in gamepads) if (null != gamepads[e] && gamepads[e].buttons && gamepads[e].buttons[7].pressed) {
      Z = gamepads[e];
      gc && vd && !IsMobile && (gc = !1);
      break
    }
  } else Z = null;
  if (vd && !gc && !(0 >= selfHealth)) {
    e = Date.now();
    var d = 80;
    if (Gc) var f, g, d = 160;
    a = selfMoveSpeed;
    Yc || (e < Fc && (a /= 4), Gc && Hc || (e = !1, null != Z ? (f = Z.axes[0], g = Z.axes[1], d = Math.atan2(g, f), f = Math.sqrt(f * f + g * g), .15 < f && (selfAngle > d + y && (selfAngle -= 2 * y), selfAngle < d - y && (selfAngle += 2 * y), selfAngle = (4 * selfAngle + d) / 5), .9 < f && (e = !0)) : !IsMobile && (Math.abs(qc - window.innerHeight / 2) > d || Math.abs(pc - window.innerWidth / 2) > d) && (e = !0), IsMobile && sf && (e = !0), Ic && (e = !1), e && (playerX += Math.cos(selfAngle) * a * b, playerY += Math.sin(selfAngle) * a * b, 0 > playerX && (playerX = 0), playerX > td && (playerX = td), 0 > playerY && (playerY = 0), playerY > ud && (playerY = ud), currentX = playerX, currentY = playerY, Jc = !1)), Gc && Hc && entities[Hc] && (currentX = playerX = entities[Hc].a, currentY = playerY = entities[Hc].b))
  }
  if (!Gc) for (var h in scraps) b = scraps[h],
  a = 80 * (1 + Bb[F]) / 2,
  Xd(playerX, playerY, b.x, b.y) < a * a + 400 && ($a("collectScrap", .2), delete scraps[h], delete entities[h]);
  // HACK: auto scrap collector - steer toward nearest scrap
  if (hackAutoScrap && vd && !gc && selfHealth > 0) {
    var hackClosestScrap = null, hackClosestDist = Infinity;
    for (var hackSid in scraps) {
      var hackS = scraps[hackSid];
      var hackDx = hackS.x - playerX, hackDy = hackS.y - playerY;
      var hackDist = hackDx * hackDx + hackDy * hackDy;
      if (hackDist < hackClosestDist) { hackClosestDist = hackDist; hackClosestScrap = hackS; }
    }
    if (hackClosestScrap) {
      selfAngle = Math.atan2(hackClosestScrap.y - playerY, hackClosestScrap.x - playerX);
    }
  }
  // HACK: auto-aim / lead-aim - rotate selfAngle toward nearest enemy
  // (rotates only; still requires you or AutoFire to shoot)
  if (hackAutoAim && vd && !gc && selfHealth > 0) {
    var hackAimTarget = null, hackAimDist = Infinity;
    for (var hackAid in players) {
      var hackAp = players[hackAid];
      if (hackAp.i <= 0) continue;
      if (!FFA && hackAp.c == selfTeam) continue;
      var hackAdx = hackAp.a - playerX, hackAdy = hackAp.b - playerY;
      var hackAdist = hackAdx * hackAdx + hackAdy * hackAdy;
      if (hackAdist < hackAimDist) { hackAimDist = hackAdist; hackAimTarget = hackAid; }
    }
    if (hackAimTarget) {
      var hackTp = players[hackAimTarget];
      var hackTx = hackTp.a, hackTy = hackTp.b;
      selfAngle = Math.atan2(hackTy - playerY, hackTx - playerX);
    }
  }
  window.requestAnimationFrame || render()
}
APIHook = function() {};
var Z = null;
gamepads = {};
var Vf = [];
canShowAd = function() {
  return adblock || "Miniclip" == Ia || lastAdWatchTime + 3E5 > Date.now() || !seenEndGame ? !1 : !0
};
function Xf() {
  canShowAd() && (console.log("attempting to watch ad!"), lastAdWatchTime = Date.now(), "undefined" != typeof jalAdPlayer ? (document.getElementById("preroll").style.display = "", (new jalAdPlayer("preroll", "prerollComplete")).showPreRoll()) : prerollComplete())
}
function Pe() {
  var a = new ArrayBuffer(1); (new DataView(a)).setUint8(0, 27);
  u.send(a);
  Jc = !0;
  Ec = firing = vd = !1;
  selfHealth = selfMaxHealth; --hc;
  Bc = !1;
  La(!0)
}
adblock = !0;
prerollComplete = function() {
  if (!adblock && "Miniclip" != Ia) {
    var a = new ArrayBuffer(1); (new DataView(a)).setUint8(0, 26);
    u.send(a);
    document.getElementById("preroll").style.display = "none";
    watchedAd = !0
  }
};
forceWatchAd = function(a) {
  adblock = !1;
  Ia = "";
  lastAdWatchTime = 0;
  seenEndGame = !0;
  a || Xf()
};
function Yf() {
  adblock = !0
}
function Zf() {
  adblock = !1
}
if ("undefined" === typeof blockAdBlock) adblock = !0;
else blockAdBlock.on(!0, Yf).onNotDetected(Zf);
// ============================================================
// HACK: Mod Settings UI  (injected at window.onload)
// ============================================================
function hackInitSettingsUI() {

  // ── 1. Inject styles inline ────────────────────────────────
  var hackStyle = document.createElement('style');
  hackStyle.textContent = 'WARIN.SPACE CLIENT MOD  — mod.css Drop this file in the same folder as client.js ============================================================ */ #hackBtn { position: fixed; bottom: 18px; right: 18px; z-index: 8000; background: rgba(5, 5, 20, 0.88); border: 1px solid #77eeff; color: #77eeff; font-family: xirod, monospace; font-size: 11px; letter-spacing: 2px; padding: 8px 14px; cursor: pointer; box-shadow: 0 0 18px rgba(119, 238, 255, 0.18); transition: background 0.15s, box-shadow 0.15s, opacity 0.15s; opacity: 0.85; } #hackBtn:hover { background: #77eeff; color: #000; box-shadow: 0 0 28px rgba(119, 238, 255, 0.5); opacity: 1; } #hackOverlay { display: none; position: fixed; inset: 0; background: rgba(0, 0, 12, 0.93); z-index: 9999; align-items: center; justify-content: center; } #hackOverlay.open { display: flex; } #hackPanel { background: #05050f; border: 1px solid #1a2a40; box-shadow: 0 0 60px rgba(119, 238, 255, 0.12), inset 0 0 40px rgba(0, 0, 25, 0.6); padding: 28px 24px 20px; width: 480px; max-width: 94vw; max-height: 86vh; overflow-y: auto; font-family: xirod, monospace; color: #aaa; scrollbar-width: thin; scrollbar-color: #1a2a40 #030308; } #hackPanel::-webkit-scrollbar        { width: 4px; } #hackPanel::-webkit-scrollbar-track  { background: #030308; } #hackPanel::-webkit-scrollbar-thumb  { background: #1a2a40; border-radius: 2px; } #hackPanel h2 { color: #77eeff; text-align: center; margin: 0 0 3px; font-size: 16px; letter-spacing: 6px; text-shadow: 0 0 18px rgba(119, 238, 255, 0.5); } #hackPanel .hkSub { text-align: center; color: #1e2e42; font-size: 8px; letter-spacing: 3px; margin: 0 0 20px; } .hkSec { font-size: 8px; color: #1e2e42; letter-spacing: 4px; margin: 16px 0 6px; border-bottom: 1px solid #0c0c1e; padding-bottom: 4px; } .hkRow { display: flex; align-items: center; gap: 10px; padding: 7px 0; border-bottom: 1px solid #08081a; } .hkInfo { flex: 1; min-width: 0; } .hkName { font-size: 11px; letter-spacing: 1px; color: #ccc; } .hkDesc { font-size: 9px; color: #2a3a50; margin-top: 2px; line-height: 1.4; } .hkKey { font-size: 9px; color: #465e84; font-family: monospace; background: #08081a; border: 1px solid #1e2840; padding: 2px 7px; white-space: nowrap; flex-shrink: 0; letter-spacing: 1px; } .hkTog { position: relative; width: 44px; height: 22px; flex-shrink: 0; } .hkTog input { opacity: 0; width: 0; height: 0; position: absolute; } .hkSlid { position: absolute; cursor: pointer; inset: 0; background: #08081a; border: 1px solid #1a2438; border-radius: 11px; transition: border-color 0.2s; } .hkSlid::before { content: ""; position: absolute; width: 16px; height: 16px; left: 2px; top: 2px; background: #1a2438; border-radius: 50%; transition: transform 0.2s, background 0.2s, box-shadow 0.2s; } input:checked + .hkSlid { border-color: #77eeff; } input:checked + .hkSlid::before { transform: translateX(22px); background: #77eeff; box-shadow: 0 0 8px rgba(119, 238, 255, 0.7); } .hkSlRow { display: flex; align-items: center; gap: 10px; padding: 9px 0; border-bottom: 1px solid #08081a; } .hkSlRow input[type="range"] { flex: 1; -webkit-appearance: none; appearance: none; height: 3px; background: #0c0c1e; border: 1px solid #1a2438; outline: none; border-radius: 2px; } .hkSlRow input[type="range"]::-webkit-slider-thumb { -webkit-appearance: none; width: 13px; height: 13px; background: #77eeff; border-radius: 50%; cursor: pointer; box-shadow: 0 0 6px rgba(119, 238, 255, 0.55); } .hkSlRow input[type="range"]::-moz-range-thumb { width: 13px; height: 13px; background: #77eeff; border-radius: 50%; cursor: pointer; border: none; } .hkVal { font-size: 10px; color: #77eeff; min-width: 40px; text-align: right; flex-shrink: 0; } #hackClose { display: block; width: 100%; margin-top: 20px; background: transparent; border: 1px solid #1a2438; color: #2a3a50; font-family: xirod, monospace; font-size: 10px; padding: 10px; cursor: pointer; letter-spacing: 4px; transition: border-color 0.15s, color 0.15s; } #hackClose:hover { border-color: #77eeff; color: #77eeff; }';
  document.head.appendChild(hackStyle);

  // ── 2. Persist / restore settings ─────────────────────────
  var KEYS = ['hackAutoFire','hackTracers','hackAutoScrap','hackHPNumbers',
              'hackEnemyRadar','hackRangeRing','hackAutoAim','hackESPArrows',
              'hackPredictLine','hackThreatMeter','hackFPS','hackEnemyDist','botEnabled'];
  try {
    var saved = JSON.parse(localStorage.hackModSettings || '{}');
    KEYS.forEach(function(k){ if (k in saved) window[k] = saved[k]; });
    if ('hackFireRate' in saved) hackFireRate = saved.hackFireRate;
    if ('hackZoom'     in saved) hackZoom     = saved.hackZoom;
  } catch(e) {}

  function hackSave() {
    var obj = { hackFireRate: hackFireRate, hackZoom: hackZoom };
    KEYS.forEach(function(k){ obj[k] = window[k]; });
    try { localStorage.hackModSettings = JSON.stringify(obj); } catch(e) {}
  }

  // ── 3. Build overlay HTML ──────────────────────────────────
  function row(id, name, desc, key) {
    return '<div class="hkRow">' +
      '<div class="hkInfo">' +
        '<div class="hkName">' + name + '</div>' +
        '<div class="hkDesc">' + desc + '</div>' +
      '</div>' +
      (key ? '<span class="hkKey">' + key + '</span>' : '') +
      '<label class="hkTog"><input type="checkbox" id="' + id + '"><span class="hkSlid"></span></label>' +
      '</div>';
  }
  function sliderRow(id, valId, name, desc, min, max, step) {
    return '<div class="hkSlRow">' +
      '<div class="hkInfo">' +
        '<div class="hkName">' + name + '</div>' +
        '<div class="hkDesc">' + desc + '</div>' +
      '</div>' +
      '<input type="range" id="' + id + '" min="' + min + '" max="' + max + '" step="' + step + '">' +
      '<span class="hkVal" id="' + valId + '"></span>' +
      '</div>';
  }

  var overlay = document.createElement('div');
  overlay.id = 'hackOverlay';
  overlay.innerHTML =
    '<div id="hackPanel">' +
      '<h2>MOD SETTINGS</h2>' +
      '<p class="hkSub">WARIN.SPACE CLIENT MOD</p>' +

      '<div class="hkSec">COMBAT</div>' +
      row('hk_autofire', 'AUTO FIRE',  'Automatically shoots at nearest enemy in range', '[') +
      row('hk_autoaim',  'AUTO AIM',   'Continuously rotates your aim toward the nearest enemy', 'T') +
      sliderRow('hk_firerate','hk_fv', 'FIRE RATE',
        'Milliseconds between shots — lower is faster (vanilla: 100ms)', 40, 200, 5) +

      '<div class="hkSec">VISUAL</div>' +
      row('hk_hpnum',     'HP NUMBERS',       'Shows exact health values beside every health bar', '') +
      row('hk_rangering', 'RANGE RING',        'Faint circle marking your maximum firing range', '') +
      row('hk_tracers',   'TRACERS',           'Lines from your ship to every other player', ']') +
      row('hk_predict',   'PREDICTION LINES',  'Dashed line showing where each ship is heading', 'N') +
      row('hk_dist',      'ENEMY DISTANCE',    'Distance in world units next to each player name', 'D') +
      sliderRow('hk_zoom','hk_zv', 'ZOOM',
        'Camera zoom — also adjustable with scroll wheel in-game', 0.3, 3.5, 0.1) +

      '<div class="hkSec">RADAR &amp; AWARENESS</div>' +
      row('hk_radar',  'ENEMY RADAR',  'Shows all enemies as dots on the minimap', '') +
      row('hk_esp',    'ESP ARROWS',   'Edge-of-screen arrows pointing to off-screen players (includes HP)', 'H') +
      row('hk_threat', 'THREAT METER', 'HUD counter: enemies within ~1.5× your firing range', '') +

      '<div class="hkSec">AUTO-PLAYER</div>' +
      row('hk_bot', 'BOT ENABLED', 'Full AI player: collects scrap, attacks enemies, retreats when hurt, upgrades automatically', 'B') +

      '<div class="hkSec">UTILITY</div>' +
      row('hk_scrap', 'AUTO SCRAP',  'Steers toward the nearest scrap pickup', '\\') +
      row('hk_fps',   'FPS COUNTER', 'Frames-per-second shown top-left in-game', 'Z') +

      '<button id="hackClose">CLOSE</button>' +
    '</div>';
  document.body.appendChild(overlay);

  // ── 4. Wire toggle inputs ──────────────────────────────────
  function bindTog(id, varName) {
    var el = document.getElementById(id);
    el.checked = window[varName];
    el.onchange = function() { window[varName] = this.checked; hackSave(); };
  }
  function bindSld(slId, vlId, varName, fmt, extra) {
    var sl = document.getElementById(slId), vl = document.getElementById(vlId);
    sl.value = window[varName]; vl.textContent = fmt(window[varName]);
    sl.oninput = function() {
      var v = parseFloat(this.value);
      window[varName] = v;
      vl.textContent = fmt(v);
      if (extra) extra(v);
      hackSave();
    };
  }

  bindTog('hk_bot',       'botEnabled');
  bindTog('hk_autofire',  'hackAutoFire');
  bindTog('hk_autoaim',   'hackAutoAim');
  bindTog('hk_hpnum',     'hackHPNumbers');
  bindTog('hk_rangering', 'hackRangeRing');
  bindTog('hk_tracers',   'hackTracers');
  bindTog('hk_predict',   'hackPredictLine');
  bindTog('hk_dist',      'hackEnemyDist');
  bindTog('hk_radar',     'hackEnemyRadar');
  bindTog('hk_esp',       'hackESPArrows');
  bindTog('hk_threat',    'hackThreatMeter');
  bindTog('hk_scrap',     'hackAutoScrap');
  bindTog('hk_fps',       'hackFPS');

  bindSld('hk_firerate', 'hk_fv', 'hackFireRate',
    function(v){ return v + 'ms'; });
  bindSld('hk_zoom', 'hk_zv', 'hackZoom',
    function(v){ return v.toFixed(1) + 'x'; },
    function(v){ if (typeof Ke !== 'undefined') Ke(); });

  // ── 5. Open / close logic ──────────────────────────────────
  function syncAllToggles() {
    ['hk_autofire','hk_autoaim','hk_hpnum','hk_rangering','hk_tracers',
     'hk_predict','hk_dist','hk_radar','hk_esp','hk_threat','hk_scrap','hk_fps']
    .forEach(function(id) {
      var varMap = {
        hk_autofire:'hackAutoFire', hk_autoaim:'hackAutoAim',
        hk_hpnum:'hackHPNumbers',   hk_rangering:'hackRangeRing',
        hk_tracers:'hackTracers',   hk_predict:'hackPredictLine',
        hk_dist:'hackEnemyDist',    hk_radar:'hackEnemyRadar',
        hk_esp:'hackESPArrows',     hk_threat:'hackThreatMeter',
        hk_scrap:'hackAutoScrap',   hk_fps:'hackFPS'
      };
      document.getElementById(id).checked = window[varMap[id]];
    });
    var fr = document.getElementById('hk_firerate');
    fr.value = hackFireRate;
    document.getElementById('hk_fv').textContent = hackFireRate + 'ms';
    var zm = document.getElementById('hk_zoom');
    zm.value = hackZoom;
    document.getElementById('hk_zv').textContent = hackZoom.toFixed(1) + 'x';
  }

  document.getElementById('hackClose').onclick = function() {
    overlay.classList.remove('open');
  };
  overlay.onclick = function(ev) {
    if (ev.target === overlay) overlay.classList.remove('open');
  };
  document.addEventListener('keydown', function(ev) {
    if (ev.key === 'Escape' && overlay.classList.contains('open')) {
      overlay.classList.remove('open');
    }
  });

  // ── 6. Gear button — fixed position, always on top ─────────
  var btn = document.createElement('button');
  btn.id = 'hackBtn';
  btn.textContent = '\u2699  MOD';
  btn.onclick = function() { syncAllToggles(); overlay.classList.add('open'); };
  document.body.appendChild(btn);
}

window.onload = function() {
  Ia = "none";
  parent !== window && (console.log("Being hosted on " + document.referrer), -1 < document.referrer.indexOf("miniclip") ? (console.log("Miniclip detected, setting up for miniclip"), console.log("Showing logo"), ra.style.visibility = "visible", document.getElementById("gamevox").style.display = "none", na.remove(), console.log("Running script"), new
  function(a, e, d) {
    var b = a.getElementsByTagName(e)[0];
    a.getElementById(d) || (a = a.createElement(e), a.id = d, a.src = "//static.miniclipcdn.com/js/mc.js", b.parentNode.insertBefore(a, b))
  } (document, "script", "miniclip-jssdk"), console.log("Setting mcAsyncInit"), window.mcAsyncInit = function() {
    MC.resize({
      height: 750
    })
  },
  console.log("Setting referrer"), Ia = "Miniclip", console.log("Done!")) : -1 < document.referrer.indexOf("kongregate") ? (Ia = "Kongregate", console.log("Kongregate detected, no set up for kongregate"), console.log("Done!")) : (Ia = document.referrer, console.log("Unrecognized referrer")));
  De = ba.createPattern(Na, "repeat");
  Md = Date.now();
  Af(null);
  "undefined" != typeof WebSocket && null != k && "undefined" != typeof DataView || alert("We have detected a potential browser incompatibility, Firefox is recommended for WarIn.Space");
  var a = document.location.search,
  a = "" + a;
  0 <= a.indexOf("code=") && (Wc = a.substr(a.indexOf("code=") + 5), document.getElementById("gamevox").style.display = "none");
  window.requestAnimationFrame && window.requestAnimationFrame(Rd);
  setInterval(Uf, 17);
  setInterval(Pf, 100);
  setInterval(Rf, 5E3);
  hackInitSettingsUI();
  Kf()
};
window.onresize = Af;
c.onmousedown = function(a) {
  Bf(a);
  1 == a.buttons ? Cf() : Ef()
};
c.onmouseup = function(a) {
  0 == a.buttons && (firing = !1)
};
c.oncontextmenu = function(a) {
  a.preventDefault();
  Bf(a)
};
c.onmousemove = function(a) {
  gc || Bf(a)
};
ha.onclick = function() {
  canShowAd() ? (Xf(), seenEndGame = !1) : Me()
};
window.addEventListener("keydown", Ff, !1);
window.addEventListener("keyup",
function(a) {
  a = a.keyCode;
  65 == a ? firing = !1 : 16 == a && (Ic = !1)
},
!1);
localStorage.name && (document.getElementById("NameArea").value = localStorage.name);