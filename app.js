'use strict';
/* TED陪练 前端逻辑：跟读发音评分 + 错词收集 */

const $ = id => document.getElementById(id);
const STOP = new Set("a an the of to in on at and or but is are was were be been am i you he she it we they this that for as with by from his her its our their my your".split(" "));
// 是否跑在本地服务器(start.bat)上：决定能否放本地原片/抓YouTube字幕
const LOCAL_SERVER = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);

let TALK = null;       // 当前演讲数据
let segStart = 0, segEnd = 0, cur = 0;
let zhVisible = false;
let recognizing = false;
let recog = null;

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
  const s=TALK.sentences[cur];
  $("sentIndex").textContent="#"+(cur+1)+" / "+TALK.count;
  $("sentEn").textContent=s.en;
  $("sentZh").textContent=s.zh;
  $("sentZh").classList.toggle("hidden", !zhVisible);
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
    if(finalText.trim()) score(finalText.trim());
    finalText="";
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

/* ---------- TTS 听原音 ---------- */
function speak(){
  if(!("speechSynthesis" in window)){ setStatus("浏览器不支持朗读功能。"); return; }
  speechSynthesis.cancel();
  const u=new SpeechSynthesisUtterance(TALK.sentences[cur].en);
  u.lang="en-US"; u.rate=0.9;
  const v=speechSynthesis.getVoices().find(v=>v.lang.startsWith("en"));
  if(v) u.voice=v;
  speechSynthesis.speak(u);
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

/* ---------- YouTube 在线学习 ---------- */
function setMediaLocal(url){
  const f=$("ytframe"); if(f){ f.src="about:blank"; f.style.display="none"; }
  const v=$("video"); const tip=$("mediaTip");
  if(LOCAL_SERVER){
    v.style.display=""; v.src=url;
    if(tip){ tip.style.display=""; tip.textContent="▶️ 先整体看一遍视频/听原声，再逐句跟读。无字幕时间轴，按句练习即可。"; }
  }else{
    v.style.display="none"; v.removeAttribute("src"); try{ v.load(); }catch(e){}
    if(tip){ tip.style.display=""; tip.innerHTML="🌐 在线测试版不含原片（视频太大未上传），但可直接逐句跟读评分。想要带视频，请用右上角 <b>▶ YouTube</b>，或在电脑上用 start.bat 运行本地完整版。"; }
  }
}
function setMediaYouTube(id){
  const v=$("video"); try{ v.pause(); }catch(e){} v.removeAttribute("src"); try{ v.load(); }catch(e){} v.style.display="none";
  let f=$("ytframe");
  if(!f){
    f=document.createElement("iframe"); f.id="ytframe"; f.className="ytframe";
    f.setAttribute("allow","autoplay; encrypted-media; picture-in-picture; fullscreen");
    f.setAttribute("allowfullscreen","true");
    $("mediaPane").insertBefore(f, $("mediaPane").firstChild);
  }
  f.style.display="block";
  f.src="https://www.youtube.com/embed/"+id+"?rel=0&modestbranding=1";
  const tip=$("mediaTip"); if(tip) tip.style.display="none";
}
function parseYouTubeId(input){
  const s=String(input||"").trim();
  const m=s.match(/(?:youtu\.be\/|[?&]v=|\/embed\/|\/shorts\/|\/live\/)([A-Za-z0-9_-]{11})/);
  if(m) return m[1];
  if(/^[A-Za-z0-9_-]{11}$/.test(s)) return s;
  return null;
}
function startYouTubeTalk(id, title, rawSentences){
  const sentences=rawSentences.map((s,i)=>({i, en:(s.en||"").trim(), zh:(s.zh||"").trim()}))
    .filter(s=>s.en && !/^(Translator|Reviewer|译者|审校)\s*[:：]/i.test(s.en) && !/^\[(Music|Applause|Laughter|音乐|掌声|笑声)\]?/i.test(s.en));
  if(!sentences.length){ ytStatus("没有可用的句子。"); return; }
  sentences.forEach((s,i)=>s.i=i);
  const segs=[]; for(let s=0; s*10<sentences.length; s++){ segs.push({name:"第"+(s+1)+"段", start:s*10, end:Math.min(s*10+9, sentences.length-1)}); }
  TALK={ id:"yt_"+id, title, category:"YouTube", folder:null, video:null, audio:null, sentences, segments:segs, count:sentences.length };
  zhVisible=false; $("sentZh").classList.add("hidden");
  renderSegOptions(); $("segSelect").value=0; onSegChange();
}
async function ytLoad(){
  const id=parseYouTubeId($("ytUrl").value);
  if(!id){ ytStatus("链接无法识别，请粘贴 https://www.youtube.com/watch?v=... 或 https://youtu.be/..."); return; }
  setMediaYouTube(id);
  if(!LOCAL_SERVER){
    ytStatus("🌐 在线版无法自动抓字幕（没有本地服务）。视频已可播放——请用下方“手动粘贴字幕”开始练习。");
    return;
  }
  ytStatus("视频已载入。正在抓取英文字幕和中文翻译…（首次可能要几秒）");
  try{
    const res=await fetch("/yt/captions?v="+encodeURIComponent(id));
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
  $("ttsBtn").onclick=speak;
  $("zhToggle").onclick=()=>{ zhVisible=!zhVisible; $("sentZh").classList.toggle("hidden",!zhVisible); };
  $("errBtn").onclick=openErr;
  $("closeErr").onclick=closeErr;
  $("mask").onclick=()=>{ closeErr(); closeYt(); };
  $("exportBtn").onclick=exportErr;
  $("ytBtn").onclick=openYt;
  $("closeYt").onclick=closeYt;
  $("ytLoadBtn").onclick=ytLoad;
  $("ytManualBtn").onclick=ytManual;
  $("ytUrl").onkeydown=(e)=>{ if(e.key==="Enter") ytLoad(); };

  if((window.TALKS||[]).length) onTalkChange();
  else setStatus("还没有演讲数据，请先运行 tools\\build-talk.ps1 生成。");
}
document.addEventListener("DOMContentLoaded", init);
