'use strict';
/* TED陪练 前端逻辑：跟读发音评分 + 错词收集 */

const $ = id => document.getElementById(id);
const STOP = new Set("a an the of to in on at and or but is are was were be been am i you he she it we they this that for as with by from his her its our their my your".split(" "));
// 是否跑在本地服务器(start.bat)上：决定能否放本地原片/抓YouTube字幕
const LOCAL_SERVER = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
// 在线后端地址(部署 Cloudflare Worker 后由 window.TED_API_BASE 提供)；留空则线上版用手动字幕。
let API_BASE = (typeof window!=="undefined" && window.TED_API_BASE) ? window.TED_API_BASE : "";
function backendBase(){ return LOCAL_SERVER ? "" : API_BASE; }
function hasBackend(){ return LOCAL_SERVER || !!API_BASE; }

let TALK = null;       // 当前演讲数据
let segStart = 0, segEnd = 0, cur = 0;
let subMode = "bi";   // 字幕模式：bi=中英双字幕  en=仅英文
let speed = 1;        // 播放速度
let ytApiReady = false, ytPlayer = null, ytPendingId = null, listenTimer = null;
window.onYouTubeIframeAPIReady = function(){
  ytApiReady = true;
  if(ytPendingId){ const id=ytPendingId; ytPendingId=null; createYtPlayer(id); }
};
let recognizing = false;
let recog = null;
let mode = "local";   // local=本地原片  online=在线YouTube

/* ---------- 工具 ---------- */
function setStatus(t){ $("status").textContent = t || ""; }
function mediaUrl(relpath, file){
  const parts = String(relpath).split("/").filter(Boolean).map(encodeURIComponent);
  return "/materials/" + parts.join("/") + "/" + encodeURIComponent(file);
}
function asArray(x){ return Array.isArray(x) ? x : (x==null ? [] : [x]); }
function norm(s){ return (s||"").toLowerCase().replace(/[^a-z0-9'\s]/g," ").split(/\s+/).filter(Boolean); }

/* 用最长公共子序列标记 target 里哪些词被读对 */
function lcsMatch(target, heard){
  const n=target.length, m=heard.length;
  const dp=Array.from({length:n+1},()=>new Array(m+1).fill(0));
  for(let i=1;i<=n;i++) for(let j=1;j<=m;j++)
    dp[i][j] = target[i-1]===heard[j-1] ? dp[i-1][j-1]+1 : Math.max(dp[i-1][j],dp[i][j-1]);
  const matched=new Array(n).fill(false);
  let i=n,j=m;
  while(i>0&&j>0){
    if(target[i-1]===heard[j-1]){matched[i-1]=true;i--;j--;}
    else if(dp[i-1][j]>=dp[i][j-1])i--; else j--;
  }
  return matched;
}

/* ---------- localStorage ---------- */
function loadProg(id){ try{return JSON.parse(localStorage.getItem("ted_prog_"+id))||{scores:{}};}catch(e){return {scores:{}};} }
function saveProg(id,p){ localStorage.setItem("ted_prog_"+id, JSON.stringify(p)); }
function loadErr(){ try{return JSON.parse(localStorage.getItem("ted_errwords"))||{};}catch(e){return {};} }
function saveErr(e){ localStorage.setItem("ted_errwords", JSON.stringify(e)); }

function logErrorWords(words, sentenceEn){
  if(!words.length) return;
  const store = loadErr();
  const today = new Date().toISOString().slice(0,10);
  words.forEach(w=>{
    if(!store[w]) store[w]={count:0, examples:[], talks:{}, last:today};
    store[w].count++; store[w].last=today;
    store[w].talks[TALK.id]=true;
    if(store[w].examples.length<3 && !store[w].examples.includes(sentenceEn)) store[w].examples.push(sentenceEn);
  });
  saveErr(store);
  refreshErrCount();
}
function refreshErrCount(){ $("errCount").textContent = Object.keys(loadErr()).length; }

/* ---------- 渲染 ---------- */
function renderTalkOptions(){
  const sel=$("talkSelect");
  sel.innerHTML="";
  const talks=asArray(window.TALKS);
  const groups={};
  talks.forEach(t=>{ const c=t.category||"其他"; (groups[c]=groups[c]||[]).push(t); });
  Object.keys(groups).forEach(cat=>{
    const og=document.createElement("optgroup"); og.label=cat;
    groups[cat].forEach(t=>{
      const o=document.createElement("option");
      o.value=t.id; o.textContent=t.title+"（"+t.count+"句）";
      og.appendChild(o);
    });
    sel.appendChild(og);
  });
}
function renderSegOptions(){
  const sel=$("segSelect");
  sel.innerHTML="";
  TALK.segments.forEach((s,idx)=>{
    const o=document.createElement("option");
    o.value=idx; o.textContent=s.name+"（第"+(s.start+1)+"-"+(s.end+1)+"句）";
    sel.appendChild(o);
  });
}
function renderSentence(){
  if(rp.on) rpStop(true);   // 手动切句/换演讲时退出配音
  stopPlayback();   // 切句时停止上一句的播放，避免串音（下一句需重新点“听原声”）
  const s=TALK.sentences[cur];
  $("sentIndex").textContent="#"+(cur+1)+" / "+TALK.count;
  applySubtitle(s);
  $("result").classList.add("hidden");
  $("prevBtn").disabled = cur<=segStart;
  $("nextBtn").disabled = cur>=segEnd;
  updateSegProgress();
  setStatus("");
}
function updateSegProgress(){
  const prog=loadProg(TALK.id);
  let done=0;
  for(let k=segStart;k<=segEnd;k++) if(prog.scores[k]!=null) done++;
  const total=segEnd-segStart+1;
  $("segProgress").textContent=done+"/"+total;
  $("progressFill").style.width=(total? Math.round(done/total*100):0)+"%";
}

/* ---------- 评分 ---------- */
function score(heardText){
  const s=TALK.sentences[cur];
  const target=norm(s.en), heard=norm(heardText);
  if(!target.length) return;
  const matched=lcsMatch(target,heard);
  const matchedCount=matched.filter(Boolean).length;
  const completeness=matchedCount/target.length;                 // 你读全了多少
  const accuracy = heard.length? matchedCount/heard.length : 0;   // 你说的里多少是对的
  const final=Math.round((completeness*0.6+accuracy*0.4)*100);

  // 逐词对照：原句每个显示词可能拆成多个标准化 token，按 token 数推进指针，精确对齐
  const origWords=s.en.split(/\s+/).filter(Boolean);
  let ti=0; const html=origWords.map(w=>{
    const subs=norm(w); if(!subs.length) return w;   // 纯标点
    let ok=true; for(let k=0;k<subs.length;k++){ if(!matched[ti+k]) ok=false; }
    ti+=subs.length;
    return `<span class="${ok?'w-ok':'w-miss'}">${w}</span>`;
  }).join(" ");
  $("diff").innerHTML=html;
  $("heard").textContent=heardText||"（没听清）";
  $("scoreNum").textContent=final;
  $("accuracy").textContent=Math.round(accuracy*100)+"%";
  $("completeness").textContent=Math.round(completeness*100)+"%";
  $("result").classList.remove("hidden");

  // 记进度（取最高分）
  const prog=loadProg(TALK.id);
  if(prog.scores[cur]==null || final>prog.scores[cur]) prog.scores[cur]=final;
  saveProg(TALK.id,prog);
  updateSegProgress();

  // 漏读/不准的实词 → 错词本
  const missed=[];
  target.forEach((t,k)=>{ if(!matched[k] && !STOP.has(t) && t.length>2) missed.push(t); });
  logErrorWords([...new Set(missed)], s.en);

  if(rp.on){ rpAfterScore(final); return; }
  if(final>=85) setStatus("👍 很棒！发音清晰完整。");
  else if(final>=70) setStatus("不错，再注意红色的词。");
  else setStatus("多听一遍原音，放慢跟读红色的词。");
}

/* ---------- 语音识别（跟读） ---------- */
function initRecog(){
  const SR=window.SpeechRecognition||window.webkitSpeechRecognition;
  if(!SR){
    $("recBtn").disabled=true;
    setStatus("当前浏览器不支持语音识别，请用 Chrome 打开（通过 start.bat 启动）。");
    return;
  }
  recog=new SR();
  recog.lang="en-US"; recog.interimResults=true; recog.maxAlternatives=1; recog.continuous=false;
  let finalText="";
  recog.onresult=e=>{
    let interim="";
    for(let i=e.resultIndex;i<e.results.length;i++){
      const r=e.results[i];
      if(r.isFinal) finalText+=r[0].transcript+" "; else interim+=r[0].transcript;
    }
    setStatus("听到：" + (finalText+interim).trim());
  };
  recog.onerror=e=>{
    recognizing=false; recBtnUI(false);
    if(e.error==="not-allowed"||e.error==="service-not-allowed")
      setStatus("麦克风被拒绝。请在地址栏左侧允许麦克风权限后重试。");
    else if(e.error==="no-speech") setStatus("没听到声音，再试一次。");
    else setStatus("识别出错："+e.error);
  };
  recog.onend=()=>{
    recognizing=false; recBtnUI(false);
    const txt=finalText.trim(); finalText="";
    if(txt) score(txt);
    else if(rp.on && (rp.phase==="speaking" || rp.phase==="scoring")) rpNoHeard();
  };
  $("recBtn").onclick=()=>{
    if(recognizing){ recog.stop(); return; }
    finalText=""; recognizing=true; recBtnUI(true);
    setStatus("🎙️ 正在听… 请朗读上面的英文句子（说完会自动评分）");
    try{ recog.start(); }catch(e){ recognizing=false; recBtnUI(false); }
  };
}
function recBtnUI(on){
  const b=$("recBtn");
  b.classList.toggle("recording",on);
  b.textContent= on? "■ 停止" : "🎤 开始跟读";
}

/* ---------- 听原声 / 变速 ---------- */
function clearListenTimer(){ if(listenTimer){ clearTimeout(listenTimer); listenTimer=null; } }
function stopPlayback(){
  clearListenTimer();
  if(ytPlayer && ytPlayer.pauseVideo){ try{ ytPlayer.pauseVideo(); }catch(e){} }
  const v=$("video"); if(v){ try{ v.pause(); }catch(e){} }
  if(window.speechSynthesis){ try{ speechSynthesis.cancel(); }catch(e){} }
}
function createYtPlayer(id){
  if(ytPlayer && ytPlayer.loadVideoById){ ytPlayer.loadVideoById(id); try{ ytPlayer.setPlaybackRate(speed); }catch(e){} return; }
  ytPlayer = new YT.Player("ytmount", {
    videoId: id,
    playerVars: { rel:0, modestbranding:1, playsinline:1 },
    events: { onReady:(e)=>{ try{ e.target.setPlaybackRate(speed); }catch(_){} } }
  });
}
function fallbackIframe(id){
  const el=document.getElementById("ytmount"); if(!el) return;
  if(el.tagName==="IFRAME"){ el.src="https://www.youtube.com/embed/"+id+"?rel=0&modestbranding=1"; return; }
  el.innerHTML="";
  const f=document.createElement("iframe"); f.className="ytframe";
  f.setAttribute("allow","autoplay; encrypted-media; picture-in-picture; fullscreen"); f.setAttribute("allowfullscreen","true");
  f.src="https://www.youtube.com/embed/"+id+"?rel=0&modestbranding=1";
  el.appendChild(f);
}
function speakTTS(text){
  if(!("speechSynthesis" in window)){ setStatus("浏览器不支持朗读。"); return; }
  speechSynthesis.cancel();
  const u=new SpeechSynthesisUtterance(text); u.lang="en-US"; u.rate=Math.max(0.5,Math.min(1.5,speed));
  const vo=speechSynthesis.getVoices().find(v=>v.lang.startsWith("en")); if(vo) u.voice=vo;
  speechSynthesis.speak(u);
}
function listenSentence(){
  const s=TALK && TALK.sentences[cur]; if(!s) return;
  clearListenTimer();
  // YouTube：跳到这一句的时间点，播放该句原声（到下一句自停）
  if(isYouTubeTalk() && ytPlayer && ytPlayer.seekTo && s.t!=null){
    try{
      ytPlayer.setPlaybackRate(speed);
      ytPlayer.seekTo(s.t, true); ytPlayer.playVideo();
      const next=TALK.sentences[cur+1];
      const dur=(next && next.t!=null) ? Math.max(1.2, next.t - s.t) : 6;
      listenTimer=setTimeout(()=>{ try{ ytPlayer.pauseVideo(); }catch(e){} }, (dur/(speed||1))*1000 + 250);
      setStatus("▶ 正在播放这一句的原声…"); return;
    }catch(e){}
  }
  // 本地原片/电影：跳到这一句的时间点播放原声，到下一句自停
  const v=$("video");
  if(v.getAttribute("src") && v.style.display!=="none"){
    try{ v.playbackRate=speed; }catch(e){}
    if(s.t!=null){
      try{ v.currentTime=s.t; }catch(e){}
      v.play();
      const next=TALK.sentences[cur+1];
      const end=(next && next.t!=null) ? next.t : (s.t+6);
      const dur=Math.max(0.8, end - s.t);
      listenTimer=setTimeout(()=>{ try{ v.pause(); }catch(e){} setStatus(""); }, (dur/(speed||1))*1000 + 150);
      setStatus("▶ 正在播放这一句的原声…");
    }else{
      if(v.paused){ v.play(); setStatus("▶ 播放原视频（拖动进度条可定位本句）"); } else { v.pause(); setStatus(""); }
    }
    return;
  }
  // 回退：朗读本句（无逐句时间戳/在线无原片时）
  speakTTS(s.en);
  setStatus("（本篇无逐句原声，用朗读示范代替）");
}
function setSpeed(r){
  speed=parseFloat(r)||1;
  const v=$("video"); if(v){ try{ v.playbackRate=speed; }catch(e){} }
  if(ytPlayer && ytPlayer.setPlaybackRate){ try{ ytPlayer.setPlaybackRate(speed); }catch(e){} }
}

/* ---------- 错词本抽屉 ---------- */
function openErr(){
  const store=loadErr();
  const list=$("errList"); list.innerHTML="";
  const words=Object.keys(store).sort((a,b)=>store[b].count-store[a].count);
  if(!words.length){ list.innerHTML='<div class="empty">还没有错词。开始跟读后，漏读或读不准的词会自动记到这里。</div>'; }
  words.forEach(w=>{
    const d=store[w];
    const div=document.createElement("div"); div.className="err-item";
    div.innerHTML=`<div class="err-word">${w}</div>
      <div class="err-meta">出现 ${d.count} 次 · 最近 ${d.last}<br>例：${(d.examples[0]||"").slice(0,60)}</div>`;
    list.appendChild(div);
  });
  $("errPanel").classList.remove("hidden"); $("mask").classList.remove("hidden");
}
function closeErr(){ $("errPanel").classList.add("hidden"); $("mask").classList.add("hidden"); }
function exportErr(){
  const store=loadErr();
  const words=Object.keys(store).sort((a,b)=>store[b].count-store[a].count);
  if(!words.length){ alert("还没有错词可导出。"); return; }
  let txt="# TED陪练 错词导出  "+new Date().toLocaleString()+"\n";
  txt+="# 复盘用：单词 | 出现次数 | 最近日期 | 例句\n\n";
  words.forEach(w=>{ const d=store[w]; txt+=`${w}\t${d.count}\t${d.last}\t${d.examples[0]||""}\n`; });
  txt+="\n# —— 把上面内容发给 Claude，可自动生成「词根词缀+联想」的 Anki 卡片 ——\n";
  const blob=new Blob([txt],{type:"text/plain;charset=utf-8"});
  const a=document.createElement("a");
  a.href=URL.createObjectURL(blob); a.download="错词导出_"+new Date().toISOString().slice(0,10)+".txt";
  a.click();
}

/* ---------- 切换演讲/段落 ---------- */
function loadTalkData(id, cb){
  const old=$("talkdata"); if(old) old.remove();
  window.TALK_DATA=null;
  const s=document.createElement("script");
  s.id="talkdata"; s.src="data/"+id+".js?"+Date.now();
  s.onload=()=>cb(window.TALK_DATA);
  s.onerror=()=>setStatus("加载演讲数据失败："+id);
  document.body.appendChild(s);
}
function onTalkChange(){
  const id=$("talkSelect").value;
  loadTalkData(id, data=>{
    TALK=data;
    TALK.segments=asArray(TALK.segments);
    TALK.sentences=asArray(TALK.sentences);
    setMediaLocal(mediaUrl(TALK.folder, TALK.video));
    renderSegOptions();
    $("segSelect").value=0;
    onSegChange();
  });
}
function onSegChange(){
  const idx=parseInt($("segSelect").value,10)||0;
  const seg=TALK.segments[idx];
  segStart=seg.start; segEnd=seg.end; cur=segStart;
  $("segName").textContent=seg.name;
  renderSentence();
}

/* ---------- 字幕模式：中英双字幕 / 仅英文（缺中文时即时生成） ---------- */
function trCacheGet(en){ try{ return (JSON.parse(localStorage.getItem("ted_tr")||"{}"))[en]; }catch(e){ return null; } }
function trCacheSet(en,zh){ try{ const o=JSON.parse(localStorage.getItem("ted_tr")||"{}"); o[en]=zh; localStorage.setItem("ted_tr", JSON.stringify(o)); }catch(e){} }

function applySubtitle(s){
  $("sentEn").textContent=s.en;
  const zhEl=$("sentZh");
  if(subMode==="en"){ zhEl.classList.add("hidden"); return; }
  zhEl.classList.remove("hidden");
  if(s.zh){ zhEl.textContent=s.zh; return; }
  const cached=trCacheGet(s.en);
  if(cached){ s.zh=cached; zhEl.textContent=cached; return; }
  if(hasBackend()){ zhEl.textContent="（生成中文中…）"; translateSentence(s); }
  else { zhEl.textContent="（在线版无法自动生成中文；本机版可，或用手动字幕的 || 提供）"; }
}
async function translateSentence(s){
  try{
    const res=await fetch(backendBase()+"/translate?q="+encodeURIComponent(s.en)+"&tl=zh-CN");
    const d=await res.json();
    if(d.ok && d.zh){ s.zh=d.zh; trCacheSet(s.en, d.zh); if(TALK && TALK.sentences[cur]===s && subMode!=="en"){ $("sentZh").textContent=d.zh; } }
    else if(TALK && TALK.sentences[cur]===s && subMode!=="en"){ $("sentZh").textContent="（翻译失败，可重试）"; }
  }catch(e){ if(TALK && TALK.sentences[cur]===s && subMode!=="en"){ $("sentZh").textContent="（翻译失败，可重试）"; } }
}
function setSub(m){
  subMode=m; try{ localStorage.setItem("ted_submode", m); }catch(e){}
  $("subBi").classList.toggle("active", m==="bi");
  $("subEn").classList.toggle("active", m==="en");
  if(TALK) applySubtitle(TALK.sentences[cur]);
}

/* ---------- YouTube 在线学习 ---------- */
function setMediaLocal(url){
  clearListenTimer();
  if(ytPlayer && ytPlayer.pauseVideo){ try{ ytPlayer.pauseVideo(); }catch(e){} }
  const el=document.getElementById("ytmount"); if(el){ el.classList.add("hidden"); }
  const v=$("video"); v.onerror=null; const tip=$("mediaTip");
  if(LOCAL_SERVER){
    v.style.display=""; v.src=url; try{ v.playbackRate=speed; }catch(e){}
    if(tip){ tip.style.display=""; tip.textContent="▶️ 整体看一遍后逐句跟读。点「听原声」播放原视频，拖动进度条可定位本句。"; }
  }else{
    v.style.display="none"; v.removeAttribute("src"); try{ v.load(); }catch(e){}
    if(tip){ tip.style.display=""; tip.innerHTML="🌐 在线测试版不含原片（视频太大未上传），但可直接逐句跟读评分。想要带视频，请切到 <b>🌐 在线视频</b> 用 YouTube，或在电脑上用 start.bat 运行本地完整版。"; }
  }
}
function setMediaYouTube(id){
  clearListenTimer();
  const v=$("video"); try{ v.pause(); }catch(e){} v.removeAttribute("src"); try{ v.load(); }catch(e){} v.style.display="none";
  const tip=$("mediaTip"); if(tip) tip.style.display="none";
  const el=document.getElementById("ytmount"); if(el){ el.classList.remove("hidden"); }
  if(ytApiReady && window.YT && window.YT.Player){ createYtPlayer(id); }
  else {
    ytPendingId=id;
    setTimeout(()=>{ if(ytPendingId===id && !(window.YT && window.YT.Player)){ fallbackIframe(id); ytPendingId=null; } }, 2500);
  }
}
function parseYouTubeId(input){
  const s=String(input||"").trim();
  const m=s.match(/(?:youtu\.be\/|[?&]v=|\/embed\/|\/shorts\/|\/live\/)([A-Za-z0-9_-]{11})/);
  if(m) return m[1];
  if(/^[A-Za-z0-9_-]{11}$/.test(s)) return s;
  return null;
}
function startYouTubeTalk(id, title, rawSentences){
  const sentences=rawSentences.map((s,i)=>({i, en:(s.en||"").trim(), zh:(s.zh||"").trim(), t:(typeof s.t==="number"? s.t : null)}))
    .filter(s=>s.en && !/^(Translator|Reviewer|译者|审校)\s*[:：]/i.test(s.en) && !/^\[(Music|Applause|Laughter|音乐|掌声|笑声)\]?/i.test(s.en));
  if(!sentences.length){ ytStatus("没有可用的句子。"); return; }
  sentences.forEach((s,i)=>s.i=i);
  const segs=[]; for(let s=0; s*10<sentences.length; s++){ segs.push({name:"第"+(s+1)+"段", start:s*10, end:Math.min(s*10+9, sentences.length-1)}); }
  TALK={ id:"yt_"+id, title, category:"YouTube", folder:null, video:null, audio:null, sentences, segments:segs, count:sentences.length };
  renderSegOptions(); $("segSelect").value=0; onSegChange();
}
async function ytLoad(){
  const id=parseYouTubeId($("ytUrl").value);
  if(!id){ ytStatus("链接无法识别，请粘贴 https://www.youtube.com/watch?v=... 或 https://youtu.be/..."); return; }
  setMediaYouTube(id);
  if(!hasBackend()){
    ytStatus("🌐 在线版未配置后端，无法自动抓字幕。视频已可播放——请点「手动字幕」粘贴英文开始练习。");
    return;
  }
  ytStatus("视频已载入。正在抓取英文字幕和中文翻译…（首次可能要几秒）");
  try{
    const res=await fetch(backendBase()+"/yt/captions?v="+encodeURIComponent(id));
    const data=await res.json();
    if(data.ok && data.sentences && data.sentences.length){
      startYouTubeTalk(id, data.title||("YouTube "+id), data.sentences);
      ytStatus("✅ 已载入 "+data.sentences.length+" 句字幕，关闭本窗口开始跟读。");
      setTimeout(closeYt, 900);
    }else{
      ytStatus("⚠️ "+(data.msg||"未取到字幕")+"\n视频已可播放，可用下方“手动粘贴字幕”开始练习。");
    }
  }catch(e){
    ytStatus("⚠️ 抓取失败："+e+"\n视频仍可播放；请用下方手动粘贴字幕，或确认本机能访问 YouTube。");
  }
}
function ytManual(){
  const raw=$("ytManualText").value.trim();
  if(!raw){ ytStatus("请先在下面粘贴英文字幕。"); return; }
  let lines=raw.split(/\r?\n+/).map(s=>s.trim()).filter(Boolean);
  if(lines.length<=1){ lines=raw.replace(/([.!?])\s+/g,"$1\n").split(/\n+/).map(s=>s.trim()).filter(Boolean); }
  const sentences=lines.map((line)=>{ const p=line.split("||"); return { en:(p[0]||"").trim(), zh:(p[1]||"").trim() }; });
  const id=parseYouTubeId($("ytUrl").value);
  if(id) setMediaYouTube(id);
  startYouTubeTalk(id||"manual", "YouTube（手动字幕）", sentences);
  ytStatus("✅ 已用手动字幕开始（"+sentences.length+" 句）。");
  setTimeout(closeYt, 600);
}
function ytStatus(t){ $("ytStatus").textContent=t||""; }
function openYt(){ $("ytPanel").classList.remove("hidden"); $("mask").classList.remove("hidden"); }
function closeYt(){ $("ytPanel").classList.add("hidden"); $("mask").classList.add("hidden"); }

/* ---------- 🎬 英文电影跟学 ---------- */
let movieVideoUrl=null, movieSentences=null, movieTitle="英文电影";
function movieStatus(t){ const e=$("movieStatus"); if(e) e.textContent=t||""; }

// 从台词里提取说话人标注：支持 "JACK: Hello" / "- Jack: Hello" / "[Jack] Hello" / "(Jack) Hello"
function extractSpeaker(en){
  let m=en.match(/^\s*-?\s*([A-Z][A-Za-z .'\-]{0,24}?)\s*[:：]\s+(.+)$/);
  if(m && !/^(https?|Note|Warning)$/i.test(m[1].trim())) return { sp:m[1].trim(), text:m[2].trim() };
  m=en.match(/^\s*\[([^\]]{1,25})\]\s*(.+)$/);
  if(m) return { sp:m[1].trim(), text:m[2].trim() };
  m=en.match(/^\s*\(([^)]{1,25})\)\s*(.+)$/);
  if(m) return { sp:m[1].trim(), text:m[2].trim() };
  return { sp:"", text:en };
}

// 解析字幕：支持 .srt/.vtt（含时间戳），也支持每行一句(可 || 分隔中英)的纯文本
function parseSubtitles(text){
  text=String(text||"").replace(/\r/g,"");
  if(/-->/.test(text)){
    const body=text.replace(/^﻿?WEBVTT[^\n]*\n/,"");
    const blocks=body.split(/\n{2,}/);
    const out=[];
    for(let b of blocks){
      let lines=b.split("\n").map(x=>x.trim()).filter(Boolean);
      if(!lines.length) continue;
      if(/^\d+$/.test(lines[0])) lines=lines.slice(1);
      if(!lines.length) continue;
      let t=null, end=null, textLines=lines;
      const m=lines[0].match(/(\d{1,2}):(\d{2}):(\d{2})[.,](\d{1,3})\s*--?>\s*(\d{1,2}):(\d{2}):(\d{2})[.,](\d{1,3})/);
      if(m){
        t=(+m[1])*3600+(+m[2])*60+(+m[3])+(parseInt((m[4]+"000").slice(0,3),10))/1000;
        end=(+m[5])*3600+(+m[6])*60+(+m[7])+(parseInt((m[8]+"000").slice(0,3),10))/1000;
        textLines=lines.slice(1);
      }
      const parts=textLines.map(l=>l.replace(/<[^>]+>/g,"").replace(/\{[^}]+\}/g,"").trim()).filter(Boolean);
      if(!parts.length) continue;
      let en="", zh="";
      const joined=parts.join("\n");
      if(joined.indexOf("||")>=0){
        const seg=joined.split("||");
        en=(seg[0]||"").replace(/\s+/g," ").trim(); zh=(seg[1]||"").replace(/\s+/g," ").trim();
      }else{
        const enParts=parts.filter(p=>!/[一-鿿]/.test(p));
        const zhParts=parts.filter(p=>/[一-鿿]/.test(p));
        en=((enParts.length?enParts:parts).join(" ")).replace(/\s+/g," ").trim();
        zh=zhParts.join(" ").replace(/\s+/g," ").trim();
      }
      const spx=extractSpeaker(en); en=spx.text;
      if(en) out.push({en, zh, sp:spx.sp, t: t!=null? Math.round(t*100)/100 : null, end: end!=null? Math.round(end*100)/100 : null});
    }
    return out;
  }
  // 纯文本：每行一句（|| 分隔中英）
  let lines=text.split(/\n+/).map(s=>s.trim()).filter(Boolean);
  if(lines.length<=1) lines=text.replace(/([.!?])\s+/g,"$1\n").split(/\n+/).map(s=>s.trim()).filter(Boolean);
  return lines.map(line=>{ const p=line.split("||"); return { en:(p[0]||"").trim(), zh:(p[1]||"").trim(), t:null }; });
}

function setMediaMovie(url){
  clearListenTimer();
  if(ytPlayer && ytPlayer.pauseVideo){ try{ ytPlayer.pauseVideo(); }catch(e){} }
  const el=document.getElementById("ytmount"); if(el){ el.classList.add("hidden"); }
  const v=$("video"); v.style.display=""; v.src=url; try{ v.playbackRate=speed; }catch(e){}
  v.onerror=()=>{ if(mode==="movie") movieStatus("⚠️ 视频无法播放：可能不是直接视频文件、或跨域受限。请改用「📹 上传视频」选本地文件。"); };
  const tip=$("mediaTip"); if(tip){ tip.style.display=""; tip.textContent="🎬 电影已载入。点「听原声」播放当前句的原声，拖动进度条可定位。"; }
}
function startMovieTalk(){
  if(!movieSentences || !movieSentences.length){ movieStatus("请先上传/粘贴字幕。"); return; }
  const sentences=movieSentences.map((s,i)=>({i, en:(s.en||"").trim(), zh:(s.zh||"").trim(), sp:(s.sp||""), t:(typeof s.t==="number"? s.t : null), end:(typeof s.end==="number"? s.end : null)})).filter(s=>s.en);
  if(!sentences.length){ movieStatus("字幕解析为空。"); return; }
  sentences.forEach((s,i)=>s.i=i);
  const segs=[]; for(let s=0; s*10<sentences.length; s++){ segs.push({name:"第"+(s+1)+"段", start:s*10, end:Math.min(s*10+9, sentences.length-1)}); }
  TALK={ id:"movie", title:movieTitle||"英文电影", category:"电影", folder:null, video:null, audio:null, sentences, segments:segs, count:sentences.length };
  renderSegOptions(); $("segSelect").value=0; onSegChange();
  if(movieVideoUrl) setMediaMovie(movieVideoUrl);
}
function onMovieVideoFile(file){
  if(!file) return;
  if(movieVideoUrl){ try{ URL.revokeObjectURL(movieVideoUrl); }catch(e){} }
  movieVideoUrl=URL.createObjectURL(file);
  movieTitle=file.name.replace(/\.[^.]+$/,"");
  setMode("movie"); setMediaMovie(movieVideoUrl);
  if(movieSentences && movieSentences.length){ startMovieTalk(); }
  else { movieStatus("✅ 视频已载入。请再「上传字幕」(.srt/.vtt) 或在「链接/粘贴字幕」里粘贴字幕。"); }
}
function onMovieSubFile(file){
  if(!file) return;
  const r=new FileReader();
  r.onload=()=>{ movieSentences=parseSubtitles(String(r.result||"")); if(!movieSentences.length){ movieStatus("⚠️ 字幕解析为空，请检查文件编码(建议 UTF-8)。"); return; } setMode("movie"); startMovieTalk(); movieStatus("✅ 已载入 "+movieSentences.length+" 句字幕。"); };
  r.onerror=()=>movieStatus("读取字幕失败。");
  r.readAsText(file, "utf-8");
}
function applyMovieSubText(){
  const raw=$("movieSubText").value.trim();
  if(!raw){ movieStatus("请先粘贴字幕内容。"); return; }
  movieSentences=parseSubtitles(raw);
  if(!movieSentences.length){ movieStatus("字幕解析为空。"); return; }
  setMode("movie"); startMovieTalk(); movieStatus("✅ 已载入 "+movieSentences.length+" 句字幕。"); closeMovie();
}
function loadMovieUrl(){
  const url=$("movieUrl").value.trim();
  if(!url){ movieStatus("请粘贴视频链接。"); return; }
  // YouTube 链接不能用 <video> 播放 → 自动切到「在线视频」模式载入
  const ytid=parseYouTubeId(url);
  if(ytid){
    movieStatus("检测到 YouTube 链接，已切到「🌐 在线视频」模式载入（那里用 YouTube 播放器，可自动抓字幕或手动粘贴）。");
    closeMovie(); setMode("online"); $("ytUrl").value=url; ytLoad();
    return;
  }
  // 直链需是“直接视频文件”(.mp4/.webm…)；网页/播放页地址放不进 <video>
  const looksDirect=/\.(mp4|webm|ogg|ogv|m4v|mov)(\?|#|$)/i.test(url);
  movieVideoUrl=url; movieTitle="英文电影";
  setMode("movie"); setMediaMovie(url);
  if(movieSentences && movieSentences.length){ startMovieTalk(); }
  const head=looksDirect ? "✅ 视频链接已载入。" : "⚠️ 这不像视频直链(应以 .mp4/.webm 结尾)，已尝试载入；普通网页/视频站请用「上传视频」或「在线视频」。";
  const tail=(movieSentences&&movieSentences.length) ? "" : "请再粘贴/上传字幕。";
  movieStatus(head+tail);
}
function openMovie(){ $("moviePanel").classList.remove("hidden"); $("mask").classList.remove("hidden"); }
function closeMovie(){ $("moviePanel").classList.add("hidden"); $("mask").classList.add("hidden"); }

/* ---------- 🎭 角色扮演配音 ---------- */
// 流程：视频连续播 → 到"我的角色"台词自动静音+开识别 → 台词结束自动评分
// 低分/没听清 → 暂停，可 听原声 / 再试 / 继续。phase: null|speaking|scoring|review
const rp = { on:false, role:null, phase:null, activeIdx:-1 };

function rpEnd(i){
  const s=TALK.sentences[i];
  if(s.end!=null) return s.end;
  const nx=TALK.sentences[i+1];
  if(nx && nx.t!=null) return nx.t;
  return (s.t!=null? s.t:0)+6;
}
function rpVideoOk(){
  const v=$("video");
  return !!(TALK && v.getAttribute("src") && v.style.display!=="none");
}
function rpSpeakers(){
  const m={};
  (TALK&&TALK.sentences||[]).forEach(s=>{ if(s.sp) m[s.sp]=(m[s.sp]||0)+1; });
  return m;
}
function openRp(){
  if(!TALK){ setStatus("请先载入视频和字幕。"); return; }
  if(!rpVideoOk()){ setStatus("配音模式需要可控视频：请用「本地原片」或「英文电影」（YouTube 暂不支持）。"); return; }
  if(TALK.sentences.every(s=>s.t==null)){ setStatus("该字幕没有时间轴，无法配音。请用带时间戳的 .srt/.vtt 字幕。"); return; }
  const spk=rpSpeakers();
  const list=$("rpRoles"); list.innerHTML="";
  const mk=(val,label,checked)=>{
    const lab=document.createElement("label"); lab.className="rp-role";
    lab.innerHTML=`<input type="radio" name="rpRole" value="${val.replace(/"/g,'&quot;')}" ${checked?'checked':''}> ${label}`;
    list.appendChild(lab);
  };
  const names=Object.keys(spk).sort((a,b)=>spk[b]-spk[a]);
  names.forEach((n,i)=>mk(n, `${n}（${spk[n]} 句台词）`, i===0));
  mk("*", `🎬 全部台词（整段都由你配音${names.length? '' : '——本字幕不带人名标注'}）`, names.length===0);
  $("rpPanel").classList.remove("hidden"); $("mask").classList.remove("hidden");
}
function closeRp(){ $("rpPanel").classList.add("hidden"); $("mask").classList.add("hidden"); }
function rpIsMine(s){ return rp.role==="*" ? true : (s.sp===rp.role); }

function rpStart(){
  const sel=document.querySelector('input[name="rpRole"]:checked');
  if(!sel){ return; }
  rp.role=sel.value; rp.on=true; rp.phase=null; rp.activeIdx=-1;
  closeRp(); rpActionsShow(false);
  const b=$("rpBtn"); b.textContent="⏹ 退出配音"; b.classList.add("rp-on");
  const v=$("video");
  v.muted=false; try{ v.playbackRate=speed; }catch(e){}
  const s=TALK.sentences[cur];
  if(s && s.t!=null) v.currentTime=Math.max(0, s.t-0.4);
  v.addEventListener("timeupdate", rpTick);
  v.play();
  setStatus("🎭 配音开始：角色【"+(rp.role==="*"?"全部台词":rp.role)+"】。轮到你的台词时会自动静音，请对着画面开口说！");
}
function rpStop(silent){
  if(!rp.on) return;
  rp.on=false; rp.phase=null; rp.activeIdx=-1;
  const v=$("video");
  v.removeEventListener("timeupdate", rpTick);
  v.muted=false;
  if(recognizing && recog){ try{ recog.stop(); }catch(e){} }
  rpActionsShow(false);
  const b=$("rpBtn"); b.textContent="🎭 配音"; b.classList.remove("rp-on");
  if(!silent) setStatus("已退出配音模式。");
}
function rpToggle(){ if(rp.on) rpStop(); else openRp(); }

// 配音时轻量切句：更新文字但不打断播放
function rpShowSentence(i){
  cur=i;
  const s=TALK.sentences[i];
  $("sentIndex").textContent="#"+(i+1)+" / "+TALK.count;
  applySubtitle(s);
  $("result").classList.add("hidden");
  rpActionsShow(false);
}
function rpTick(){
  if(!rp.on || !TALK) return;
  const v=$("video"); const tNow=v.currentTime;
  if(rp.phase==="review" || rp.phase==="hearing" || rp.phase==="scoring") return;
  if(rp.phase==="speaking"){
    if(tNow >= rpEnd(rp.activeIdx)){
      rp.phase="scoring";
      if(recognizing && recog){ try{ recog.stop(); }catch(e){} }   // onend → score → rpAfterScore
      else rpNoHeard();
    }
    return;
  }
  // 观看阶段：找当前时间所在句
  let idx=-1;
  for(let i=0;i<TALK.count;i++){
    const s=TALK.sentences[i];
    if(s.t==null) continue;
    if(tNow >= s.t-0.15 && tNow < rpEnd(i)){ idx=i; break; }
  }
  if(idx<0 || idx===rp.activeIdx) return;
  rp.activeIdx=idx;
  rpShowSentence(idx);
  const s=TALK.sentences[idx];
  if(rpIsMine(s)){
    v.muted=true;
    rp.phase="speaking";
    if(recog && !recognizing){
      recognizing=true; recBtnUI(true);
      try{ recog.start(); }catch(e){ recognizing=false; recBtnUI(false); }
    }
    setStatus("🎤 该你了！大声说出上面的台词…");
  }else{
    v.muted=false;
  }
}
function rpActionsShow(on){ $("rpActions").classList.toggle("hidden", !on); }
function rpAfterScore(finalScore){
  if(!rp.on) return;
  const v=$("video");
  if(finalScore>=75){
    rp.phase=null; v.muted=false; rpActionsShow(false);
    setStatus("✅ "+finalScore+" 分，很棒！继续看下去…");
    if(v.paused) v.play();
  }else{
    rp.phase="review"; v.pause();
    rpActionsShow(true);
    setStatus("😅 "+finalScore+" 分。听听原声怎么说，再模仿一次？");
  }
}
function rpNoHeard(){
  if(!rp.on) return;
  const v=$("video");
  rp.phase="review"; v.pause(); v.muted=false;
  rpActionsShow(true);
  setStatus("没听清你的声音。点「听原声」学一遍，或「再试一次」。");
}
function rpHear(){
  const v=$("video"); const s=TALK.sentences[cur];
  if(!s || s.t==null) return;
  rp.phase="hearing";
  clearListenTimer();
  v.muted=false; v.currentTime=Math.max(0, s.t-0.05); try{ v.playbackRate=speed; }catch(e){}
  v.play();
  const dur=Math.max(0.8, rpEnd(cur)-s.t);
  listenTimer=setTimeout(()=>{
    try{ v.pause(); }catch(e){}
    rp.phase="review";
    setStatus("听完了。点「🎤 再试一次」模仿它，或「▶ 继续播放」。");
  }, (dur/(speed||1))*1000+200);
}
function rpRetry(){
  const v=$("video"); const s=TALK.sentences[cur];
  if(!s || s.t==null) return;
  clearListenTimer();
  rpActionsShow(false);
  $("result").classList.add("hidden");
  rp.phase="speaking"; rp.activeIdx=cur;
  v.muted=true; v.currentTime=Math.max(0, s.t-0.1); v.play();
  if(recog && !recognizing){
    recognizing=true; recBtnUI(true);
    try{ recog.start(); }catch(e){ recognizing=false; recBtnUI(false); }
  }
  setStatus("🎤 再来！跟着画面说这句台词…");
}
function rpContinue(){
  const v=$("video");
  clearListenTimer();
  rp.phase=null; rpActionsShow(false);
  v.muted=false;
  const e=rpEnd(cur);
  if(v.currentTime < e) v.currentTime=e+0.02;
  v.play();
  setStatus("");
}

/* ---------- 模式切换：本地原片 / 在线视频 / 英文电影 ---------- */
function isYouTubeTalk(){ return TALK && String(TALK.id).indexOf("yt_")===0; }
function isMovieTalk(){ return TALK && TALK.id==="movie"; }
function clearMedia(){
  clearListenTimer();
  if(ytPlayer && ytPlayer.pauseVideo){ try{ ytPlayer.pauseVideo(); }catch(e){} }
  const el=document.getElementById("ytmount"); if(el){ el.classList.add("hidden"); }
  const v=$("video"); v.onerror=null; v.style.display="none"; v.removeAttribute("src");
}
function setMode(m){
  if(rp.on) rpStop(true);
  mode=m;
  $("modeLocal").classList.toggle("active", m==="local");
  $("modeOnline").classList.toggle("active", m==="online");
  $("modeMovie").classList.toggle("active", m==="movie");
  $("localCtl").classList.toggle("hidden", m!=="local");
  $("onlineCtl").classList.toggle("hidden", m!=="online");
  $("movieCtl").classList.toggle("hidden", m!=="movie");
  if(m==="local"){
    ytStatus(""); movieStatus("");
    if(!TALK || isYouTubeTalk() || isMovieTalk()){
      if((window.TALKS||[]).length) onTalkChange();      // 回到本地演讲
    }else{
      setMediaLocal(mediaUrl(TALK.folder, TALK.video));   // 已是本地演讲，恢复原片
    }
  }else if(m==="online"){
    if(!isYouTubeTalk()){
      clearMedia();
      const tip=$("mediaTip");
      if(tip){ tip.style.display=""; tip.innerHTML="🌐 粘贴 YouTube 链接 → 点「载入」即可站内播放并跟读。" + (LOCAL_SERVER ? "本机会自动抓取英文字幕。" : "在线版请用「手动字幕」粘贴英文字幕。"); }
      ytStatus(LOCAL_SERVER ? "" : "提示：在线测试版无法自动抓字幕，载入视频后点「手动字幕」粘贴英文即可。");
    }
  }else if(m==="movie"){
    ytStatus("");
    if(isMovieTalk()){ if(movieVideoUrl) setMediaMovie(movieVideoUrl); }
    else if(movieSentences && movieSentences.length){ startMovieTalk(); }   // 恢复上次电影
    else {
      clearMedia();
      const tip=$("mediaTip");
      if(tip){ tip.style.display=""; tip.innerHTML="🎬 用英文电影学：点上方「📹 上传视频」选电影文件 + 「📝 上传字幕」(.srt/.vtt)，或点「链接 / 粘贴字幕」。字幕带时间轴即可逐句听原声。"; }
    }
  }
}

/* ---------- 启动 ---------- */
function init(){
  if(location.protocol==="file:")
    setStatus("⚠️ 请用 start.bat 启动（http://localhost），否则麦克风和视频无法工作。");
  renderTalkOptions();
  refreshErrCount();
  initRecog();
  if(speechSynthesis) speechSynthesis.onvoiceschanged=()=>{};

  $("talkSelect").onchange=onTalkChange;
  $("segSelect").onchange=onSegChange;
  $("prevBtn").onclick=()=>{ if(cur>segStart){cur--;renderSentence();} };
  $("nextBtn").onclick=()=>{ if(cur<segEnd){cur++;renderSentence();} };
  $("listenBtn").onclick=listenSentence;
  $("speedSel").onchange=(e)=>setSpeed(e.target.value);
  subMode = (localStorage.getItem("ted_submode")||"bi");
  $("subBi").classList.toggle("active", subMode==="bi");
  $("subEn").classList.toggle("active", subMode==="en");
  $("subBi").onclick=()=>setSub("bi");
  $("subEn").onclick=()=>setSub("en");
  $("errBtn").onclick=openErr;
  $("closeErr").onclick=closeErr;
  $("mask").onclick=()=>{ closeErr(); closeYt(); closeMovie(); closeRp(); };
  $("exportBtn").onclick=exportErr;
  $("modeLocal").onclick=()=>setMode("local");
  $("modeOnline").onclick=()=>setMode("online");
  $("modeMovie").onclick=()=>setMode("movie");
  $("ytManualOpen").onclick=openYt;
  $("closeYt").onclick=closeYt;
  $("ytLoadBtn").onclick=ytLoad;
  $("ytManualBtn").onclick=ytManual;
  $("ytUrl").onkeydown=(e)=>{ if(e.key==="Enter") ytLoad(); };
  // 英文电影
  $("movieVideo").onchange=(e)=>onMovieVideoFile(e.target.files && e.target.files[0]);
  $("movieSub").onchange=(e)=>onMovieSubFile(e.target.files && e.target.files[0]);
  $("movieMoreBtn").onclick=openMovie;
  $("closeMovie").onclick=closeMovie;
  $("movieUrlBtn").onclick=loadMovieUrl;
  $("movieSubTextBtn").onclick=applyMovieSubText;
  // 角色扮演配音
  $("rpBtn").onclick=rpToggle;
  $("closeRpBtn").onclick=closeRp;
  $("rpStartBtn").onclick=rpStart;
  $("rpHearBtn").onclick=rpHear;
  $("rpRetryBtn").onclick=rpRetry;
  $("rpGoBtn").onclick=rpContinue;

  if((window.TALKS||[]).length) onTalkChange();
  else setStatus("还没有演讲数据，请先运行 tools\\build-talk.ps1 生成。");
}
document.addEventListener("DOMContentLoaded", init);
