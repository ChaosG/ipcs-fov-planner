(() => {
  const $ = id => document.getElementById(id);
  const {D2R,R2D,vec}=Geo;
  const {sub,dot,cross,norm}=vec;
  const esc = s => String(s ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  const safeColor = (v, d='#2f6fed') => /^#[0-9a-f]{6}$/i.test(String(v||'')) ? v : d;
  const LENS = { '2.8':[94,49], '4':[70,35], '6':[46,24], '8':[43,24] };
  const COLORS = ['#2f6fed','#e07b39','#2f9e6e','#9b59b6','#c0392b','#16a085','#d4a017','#5d6d7e'];

  const S = {
    img:null, imgW:0, imgH:0, mpp:0.0119, mppW:14.5,
    cams:[], zones:[], selCam:null, selZone:null, mode:null,
    view:{az:-90*D2R, el:55*D2R, dist:40, tx:0, ty:0},
    imgX:0, imgY:0,
    planView:{zoom:1,panX:0,panY:0},
    drag:null
  };
  let nextCam=1, nextZone=1;

  // ---------- 几何（公共实现见 geometry.js） ----------
  const {footprint,insideConvex,clipPoly,polyArea}=Geo;
  const zoneRect = z => [z.x0,z.y0,z.x0+z.w,z.y0+z.h];
  const camPPF = (c,d) => Geo.ppf(c.pw,c.hf,c.h,d);

  // ---------- 持久化 ----------
  function saveState(){
    const o={mpp:S.mpp,mppW:S.mppW,imgX:S.imgX,imgY:S.imgY,nextCam,nextZone,
      cams:S.cams.map(c=>({...c})),zones:S.zones.map(z=>({...z}))};
    try{ localStorage.setItem('planner_v4',JSON.stringify(o)); }catch(e){}
  }
  function loadState(){
    try{
      const o=JSON.parse(localStorage.getItem('planner_v4')||'null');
      if(!o) return;
      S.mpp=o.mpp||S.mpp; S.mppW=o.mppW||S.mppW; S.imgX=+o.imgX||0; S.imgY=+o.imgY||0;
      S.cams=o.cams||[]; S.zones=o.zones||[];
      nextCam=o.nextCam||S.cams.length+1; nextZone=o.nextZone||S.zones.length+1;
    }catch(e){}
  }
  const DB='planner_db';
  function dbOpen(){
    return new Promise((res,rej)=>{
      const r=indexedDB.open(DB,1);
      r.onupgradeneeded=()=>r.result.createObjectStore('kv');
      r.onsuccess=()=>res(r.result); r.onerror=()=>rej(r.error);
    });
  }
  async function dbSet(k,v){
    try{const db=await dbOpen();const tx=db.transaction('kv','readwrite');tx.objectStore('kv').put(v,k);}catch(e){}
  }
  async function dbGet(k){
    try{const db=await dbOpen();return await new Promise((res,rej)=>{const tx=db.transaction('kv','readonly');const rq=tx.objectStore('kv').get(k);rq.onsuccess=()=>res(rq.result);rq.onerror=()=>rej(rq.error);});}catch(e){return null;}
  }

  // ---------- 视图 ----------
  function extents(){
    const Wm = S.img ? S.imgW*S.mpp : 20;
    const Hm = S.img ? S.imgH*S.mpp : 15;
    return [Wm,Hm];
  }
  function imgBounds(){ const [W,H]=extents(); const x=S.imgX||0,y=S.imgY||0; return [x,y,x+W,y+H]; }
  function target(){ const [x0,y0,x1,y1]=imgBounds(); return [(x0+x1)/2+(S.view.tx||0),(y0+y1)/2+(S.view.ty||0),0.8]; }

  const c3d=$('c3d'), x3=c3d.getContext('2d');
  let W3=0,H3=0,DPR=1;
  function fit3(){
    const r=c3d.getBoundingClientRect(); DPR=window.devicePixelRatio||1;
    W3=Math.max(10,r.width); H3=Math.max(10,r.height);
    c3d.width=Math.round(W3*DPR); c3d.height=Math.round(H3*DPR);
    x3.setTransform(DPR,0,0,DPR,0,0);
  }
  function projector(){
    const t=target(), {az,el,dist}=S.view;
    return Geo.makeProjector({w:W3,h:H3,target:t,az,el,dist,nearZ:0.2});
  }
  function drawTri(img,sx0,sy0,sx1,sy1,sx2,sy2,p0,p1,p2){
    const det=(sx1-sx0)*(sy2-sy0)-(sx2-sx0)*(sy1-sy0);
    if(Math.abs(det)<1e-9) return;
    const a=((p1[0]-p0[0])*(sy2-sy0)-(p2[0]-p0[0])*(sy1-sy0))/det;
    const c=((p2[0]-p0[0])*(sx1-sx0)-(p1[0]-p0[0])*(sx2-sx0))/det;
    const b=((p1[1]-p0[1])*(sy2-sy0)-(p2[1]-p0[1])*(sy1-sy0))/det;
    const d=((p2[1]-p0[1])*(sx1-sx0)-(p1[1]-p0[1])*(sx2-sx0))/det;
    const e=p0[0]-a*sx0-c*sy0, f=p0[1]-b*sx0-d*sy0;
    x3.save();
    x3.beginPath(); x3.moveTo(p0[0],p0[1]); x3.lineTo(p1[0],p1[1]); x3.lineTo(p2[0],p2[1]); x3.closePath(); x3.clip();
    x3.setTransform(DPR*a,DPR*b,DPR*c,DPR*d,DPR*e,DPR*f);
    x3.drawImage(img,0,0);
    x3.restore();
  }
  function drawGroundImage(pr){
    const img=S.img; if(!img) return;
    const [bx0,by0,bx1,by1]=imgBounds(), N=16;
    for(let i=0;i<N;i++)for(let j=0;j<N;j++){
      const u0=i/N*S.imgW,u1=(i+1)/N*S.imgW,v0=j/N*S.imgH,v1=(j+1)/N*S.imgH;
      const wx0=bx0+u0*S.mpp,wx1=bx0+u1*S.mpp,wy0=by1-v1*S.mpp,wy1=by1-v0*S.mpp;
      const p00=pr([wx0,wy1,0]),p10=pr([wx1,wy1,0]),p11=pr([wx1,wy0,0]),p01=pr([wx0,wy0,0]);
      if(!p00||!p10||!p11||!p01) continue;
      drawTri(img,u0,v0,u1,v0,u1,v1,p00,p10,p11);
      drawTri(img,u0,v0,u1,v1,u0,v1,p00,p11,p01);
    }
  }
  function draw3D(){
    const pr=projector();
    x3.clearRect(0,0,W3,H3);
    const g=x3.createLinearGradient(0,0,0,H3);
    g.addColorStop(0,'#fbfcfe'); g.addColorStop(1,'#eef2f7');
    x3.fillStyle=g; x3.fillRect(0,0,W3,H3);
    if(S.img) drawGroundImage(pr);
    // 标尺网格：以底图为中心向四周延伸 6 m
    const [tx,ty]=target();
    const R=Math.max(30, S.view.dist*1.2);
    const gx0=Math.floor(tx-R), gx1=Math.ceil(tx+R), gy0=Math.floor(ty-R), gy1=Math.ceil(ty+R);
    for(let x=Math.ceil(gx0);x<=gx1;x+=1){
      const major=Math.abs(x/5-Math.round(x/5))<1e-9;
      const a=pr([x,gy0,0.02]), b=pr([x,gy1,0.02]);
      if(!a||!b) continue;
      x3.strokeStyle=major?'rgba(30,41,59,.25)':'rgba(30,41,59,.10)';
      x3.lineWidth=major?1.2:1;
      x3.beginPath(); x3.moveTo(a[0],a[1]); x3.lineTo(b[0],b[1]); x3.stroke();
    }
    for(let y=Math.ceil(gy0);y<=gy1;y+=1){
      const major=Math.abs(y/5-Math.round(y/5))<1e-9;
      const a=pr([gx0,y,0.02]), b=pr([gx1,y,0.02]);
      if(!a||!b) continue;
      x3.strokeStyle=major?'rgba(30,41,59,.25)':'rgba(30,41,59,.10)';
      x3.lineWidth=major?1.2:1;
      x3.beginPath(); x3.moveTo(a[0],a[1]); x3.lineTo(b[0],b[1]); x3.stroke();
    }
    // 区
    for(const z of S.zones){
      if(z.hidden) continue;
      const r=zoneRect(z);
      const pts=[[r[0],r[1]],[r[2],r[1]],[r[2],r[3]],[r[0],r[3]]].map(p=>pr([p[0],p[1],0]));
      if(!pts.every(Boolean)) continue;
      x3.beginPath(); pts.forEach((p,i)=>i?x3.lineTo(p[0],p[1]):x3.moveTo(p[0],p[1])); x3.closePath();
      x3.fillStyle='rgba(245,158,11,.08)'; x3.fill();
      x3.setLineDash([6,4]); x3.strokeStyle=z.color||'#d97706'; x3.lineWidth=1.6; x3.stroke(); x3.setLineDash([]);
    }
    // 足迹
    for(const c of S.cams){
      if(c.hidden) continue;
      const fp=footprint(c); if(!fp) continue;
      const pts=fp.map(p=>pr([p[0],p[1],0]));
      if(!pts.every(Boolean)) continue;
      x3.beginPath(); pts.forEach((p,i)=>i?x3.lineTo(p[0],p[1]):x3.moveTo(p[0],p[1])); x3.closePath();
      x3.fillStyle=hexA(c.color,0.16); x3.fill();
      x3.strokeStyle=hexA(c.color,0.9); x3.lineWidth=1.8; x3.stroke();
    }
    // 四棱锥：4 条棱 + 侧面
    for(const c of S.cams){
      if(c.hidden) continue;
      const fp=footprint(c); if(!fp) continue;
      const apex=pr([c.x,c.y,c.h]);
      const pts=fp.map(p=>pr([p[0],p[1],0]));
      if(!apex||!pts.every(Boolean)) continue;
      for(let i=0;i<4;i++){
        const a=pts[i], b=pts[(i+1)%4];
        x3.beginPath(); x3.moveTo(apex[0],apex[1]); x3.lineTo(a[0],a[1]); x3.lineTo(b[0],b[1]); x3.closePath();
        x3.fillStyle=hexA(c.color,0.045); x3.fill();
      }
      x3.strokeStyle=hexA(c.color,0.75); x3.lineWidth=1.2;
      for(let i=0;i<4;i++){
        x3.beginPath(); x3.moveTo(apex[0],apex[1]); x3.lineTo(pts[i][0],pts[i][1]); x3.stroke();
      }
    }
    // 相机
    for(const c of S.cams){
      if(c.hidden) continue;
      const b=pr([c.x,c.y,0]), t=pr([c.x,c.y,c.h]);
      if(b&&t){
        x3.setLineDash([3,3]); x3.strokeStyle='#94a3b8'; x3.lineWidth=1.2;
        x3.beginPath(); x3.moveTo(b[0],b[1]); x3.lineTo(t[0],t[1]); x3.stroke(); x3.setLineDash([]);
        x3.beginPath(); x3.arc(t[0],t[1],6,0,7); x3.fillStyle=c.color; x3.fill();
        x3.beginPath(); x3.arc(t[0],t[1],9,0,7); x3.strokeStyle=hexA(c.color,0.35); x3.lineWidth=2; x3.stroke();
        x3.fillStyle='#334155'; x3.font='11px sans-serif'; x3.textAlign='left';
        x3.fillText(c.name,t[0]+11,t[1]+4);
      }
    }
    $('badge').textContent=`3D · 方位 ${Math.round(((S.view.az*R2D)%360+360)%360)}° · 仰角 ${Math.round(S.view.el*R2D)}°`;
  }

  // ---------- 平面 ----------
  const cp=$('cplan'), xp=cp.getContext('2d');
  let WP=0,HP=0, planT=null;
  function fitP(){
    const r=cp.getBoundingClientRect(); const d=window.devicePixelRatio||1;
    WP=Math.max(10,r.width); HP=Math.max(10,r.height);
    cp.width=Math.round(WP*d); cp.height=Math.round(HP*d);
    xp.setTransform(d,0,0,d,0,0);
  }
  function drawPlan(){
    const [Wm,Hm]=extents();
    const [bx0,by0,bx1,by1]=imgBounds();
    const cX=(bx0+bx1)/2, cY=(by0+by1)/2;
    xp.clearRect(0,0,WP,HP);
    xp.fillStyle='#fbfcfe'; xp.fillRect(0,0,WP,HP);
    const pad=1.5;
    const base=Math.min(WP/(Wm+pad*2), HP/(Hm+pad*2));
    const pv=S.planView||{zoom:1,panX:0,panY:0};
    if(!Number.isFinite(pv.zoom)||pv.zoom<=0) pv.zoom=1;
    if(!Number.isFinite(pv.panX)) pv.panX=0;
    if(!Number.isFinite(pv.panY)) pv.panY=0;
    const s=base*pv.zoom;
    const cx=WP/2+pv.panX, cy=HP/2+pv.panY;
    const T=(x,y)=>[cx+(x-cX)*s, cy-(y-cY)*s];
    planT={s,cx,cy,cX,cY};
    if(S.img){
      const a=T(bx0,by1), b=T(bx1,by0);
      xp.drawImage(S.img,a[0],a[1],b[0]-a[0],b[1]-a[1]);
      // 5 m 刻度
      xp.font='10px sans-serif';
      for(let x=Math.ceil(bx0/5)*5;x<=bx1;x+=5){
        const p=T(x,by1);
        const t=`${x}m`;
        const w=xp.measureText(t).width;
        xp.fillStyle='rgba(255,255,255,.88)';
        xp.fillRect(p[0]-w/2-2,p[1]-15,w+4,12);
        xp.fillStyle='#475569'; xp.textAlign='center';
        xp.fillText(t,p[0],p[1]-5);
      }
      for(let y=Math.ceil(by0/5)*5;y<=by1;y+=5){
        const p=T(bx0,y);
        const t=`${y}m`;
        const w=xp.measureText(t).width;
        xp.fillStyle='rgba(255,255,255,.88)';
        xp.fillRect(p[0]-w-4,p[1]-6,w+4,12);
        xp.fillStyle='#475569'; xp.textAlign='right';
        xp.fillText(t,p[0]-3,p[1]+3);
      }
    }
    // 全视口网格：1 m / 5 m，随平面视图平移缩放无限延伸
    const wx0=cX+(0-cx)/s, wx1=cX+(WP-cx)/s;
    const wy0=cY+(cy-HP)/s, wy1=cY+cy/s;
    const gx0=Math.floor(Math.min(wx0,wx1)), gx1=Math.ceil(Math.max(wx0,wx1));
    const gy0=Math.floor(Math.min(wy0,wy1)), gy1=Math.ceil(Math.max(wy0,wy1));
    for(let x=gx0;x<=gx1;x++){
      const major=Math.abs(x/5-Math.round(x/5))<1e-9;
      xp.strokeStyle=major?'rgba(30,41,59,.40)':'rgba(30,41,59,.17)';
      xp.lineWidth=major?1.4:1;
      const a=T(x,wy0), b=T(x,wy1);
      xp.beginPath(); xp.moveTo(a[0],a[1]); xp.lineTo(b[0],b[1]); xp.stroke();
    }
    for(let y=gy0;y<=gy1;y++){
      const major=Math.abs(y/5-Math.round(y/5))<1e-9;
      xp.strokeStyle=major?'rgba(30,41,59,.40)':'rgba(30,41,59,.17)';
      xp.lineWidth=major?1.4:1;
      const a=T(wx0,y), b=T(wx1,y);
      xp.beginPath(); xp.moveTo(a[0],a[1]); xp.lineTo(b[0],b[1]); xp.stroke();
    }
    // 区
    for(const z of S.zones){
      if(z.hidden) continue;
      const r=zoneRect(z);
      const a=T(r[0],r[3]), b=T(r[2],r[1]);
      xp.fillStyle='rgba(245,158,11,.10)';
      xp.fillRect(a[0],a[1],b[0]-a[0],b[1]-a[1]);
      xp.setLineDash([5,4]); xp.strokeStyle=z.color||'#d97706'; xp.lineWidth=1.5;
      xp.strokeRect(a[0],a[1],b[0]-a[0],b[1]-a[1]); xp.setLineDash([]);
      xp.fillStyle='#9a5b00'; xp.font='10px sans-serif'; xp.textAlign='left';
      xp.fillText(z.name,a[0]+4,a[1]-3);
    }
    // 足迹
    for(const c of S.cams){
      if(c.hidden) continue;
      const fp=footprint(c); if(!fp) continue;
      const pts=fp.map(p=>T(p[0],p[1]));
      xp.beginPath(); pts.forEach((p,i)=>i?xp.lineTo(p[0],p[1]):xp.moveTo(p[0],p[1])); xp.closePath();
      xp.fillStyle=hexA(c.color,0.16); xp.fill();
      xp.strokeStyle=hexA(c.color,0.9); xp.lineWidth=1.6; xp.stroke();
    }
    // 相机
    for(const c of S.cams){
      if(c.hidden) continue;
      const p=T(c.x,c.y);
      xp.beginPath(); xp.arc(p[0],p[1],6,0,7); xp.fillStyle=c.color; xp.fill();
      if(S.selCam===c.id){ xp.beginPath(); xp.arc(p[0],p[1],10,0,7); xp.strokeStyle=c.color; xp.lineWidth=2; xp.stroke(); }
      xp.fillStyle='#334155'; xp.font='11px sans-serif'; xp.textAlign='left';
      xp.fillText(`${c.name} H${c.h.toFixed(1)}`,p[0]+9,p[1]+4);
    }
  }
  function planToWorld(sx,sy){
    if(!planT) return [0,0];
    const {s,cx,cy,cX,cY}=planT;
    return [cX+(sx-cx)/s, cY-(sy-cy)/s];
  }

  // ---------- 列表与表单 ----------
  const eyeSVG = off => off
    ? '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 3l18 18"/><path d="M10.6 5.1A10.9 10.9 0 0 1 12 5c5 0 9 4.5 9 7a11.8 11.8 0 0 1-2.2 3.2M6.2 6.2A11.6 11.6 0 0 0 3 12c0 2.5 4 7 9 7a10.9 10.9 0 0 0 4.1-.8"/></svg>'
    : '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';

  function renderLists(){
    const zl=$('zoneList'); zl.innerHTML='';
    for(const z of S.zones){
      const el=document.createElement('div');
      el.className='item'+(S.selZone===z.id?' sel':'')+(z.hidden?' off':'');
      el.innerHTML=`<span class="dot" style="background:${safeColor(z.color,'#d97706')}"></span><span class="nm">${esc(z.name)}</span><span class="sub">${(+z.w).toFixed(2)}×${(+z.h).toFixed(2)} m</span><button class="eye${z.hidden?' off':''}" title="${z.hidden?'显示':'隐藏'}" aria-label="${z.hidden?'显示':'隐藏'}">${eyeSVG(z.hidden)}</button>`;
      el.onclick=()=>{S.selZone=z.id;S.selCam=null;renderLists();renderForms();drawAll();};
      el.querySelector('.eye').onclick=e=>{e.stopPropagation(); z.hidden=!z.hidden; saveState(); renderLists(); renderForms(); drawAll();};
      zl.appendChild(el);
    }
    const cl=$('camList'); cl.innerHTML='';
    for(const c of S.cams){
      const z=S.zones.find(x=>x.id===c.zoneId);
      const el=document.createElement('div');
      el.className='item'+(S.selCam===c.id?' sel':'')+(c.hidden?' off':'');
      el.innerHTML=`<span class="dot" style="background:${safeColor(c.color)}"></span><span class="nm">${esc(c.name)}</span><span class="sub">H${c.h.toFixed(1)} · ${lensOf(c)==='custom'?'自定义('+c.hf.toFixed(0)+'°)':lensOf(c)+'mm'} · ${esc(z?z.name:'未分配')}</span><button class="eye${c.hidden?' off':''}" title="${c.hidden?'显示':'隐藏'}" aria-label="${c.hidden?'显示':'隐藏'}">${eyeSVG(c.hidden)}</button>`;
      el.onclick=()=>{S.selCam=c.id;S.selZone=null;renderLists();renderForms();drawAll();};
      el.querySelector('.eye').onclick=e=>{e.stopPropagation(); c.hidden=!c.hidden; saveState(); renderLists(); renderForms(); drawAll();};
      cl.appendChild(el);
    }
    $('delCam').disabled=!S.selCam;
    $('delZone').disabled=!S.selZone;
    $('showCams').disabled=!S.cams.some(c=>c.hidden);
    $('showZones').disabled=!S.zones.some(z=>z.hidden);
  }
  function lensOf(c){
    if(c.lens==='custom') return 'custom';
    if(c.lens && LENS[c.lens]){
      const [h,v]=LENS[c.lens];
      if(Math.abs(c.hf-h)<0.6 && Math.abs(c.vf-v)<0.6) return c.lens;
    }
    for(const f of Object.keys(LENS)){
      const [h,v]=LENS[f];
      if(Math.abs(c.hf-h)<0.6 && Math.abs(c.vf-v)<0.6) return f;
    }
    return 'custom';
  }
  function renderForms(){
    const cf=$('camForm'), c=S.cams.find(x=>x.id===S.selCam);
    if(!c){cf.classList.add('hidden');cf.innerHTML='';}
    else{
      cf.classList.remove('hidden');
      cf.innerHTML=`<div class="grid">
        <label class="full">名称<input data-k="name" type="text" value="${esc(c.name)}"></label>
        <label class="full">负责区<select data-k="zoneId">${['auto',...S.zones.map(z=>z.id)].map(id=>`<option value="${esc(id)}" ${c.zoneId===id?'selected':''}>${id==='auto'?'自动分配':esc((S.zones.find(z=>z.id===id)||{}).name||id)}</option>`).join('')}</select></label>
        <label>X 坐标 m<input data-k="x" type="number" step="0.1" value="${c.x.toFixed(2)}"></label>
        <label>Y 坐标 m<input data-k="y" type="number" step="0.1" value="${c.y.toFixed(2)}"></label>
        <label>高度 m<input data-k="h" type="number" step="0.1" value="${c.h}"></label>
        <label>偏航°<input data-k="yaw" type="number" step="1" value="${c.yaw}"></label>
        <label>水平 H°<input data-k="hf" type="number" step="0.5" value="${c.hf}"></label>
        <label>俯仰°<input data-k="pitch" type="number" step="0.5" value="${c.pitch}"></label>
        <label>垂直 V°<input data-k="vf" type="number" step="0.5" value="${c.vf}"></label>
        <label>滚转°<input data-k="roll" type="number" step="1" value="${c.roll}"></label>
        <label>宽 px<input data-k="pw" type="number" step="16" value="${c.pw}"></label>
        <label>高 px<input data-k="ph" type="number" step="8" value="${c.ph}"></label>
        <label>颜色<input data-k="color" type="color" value="${safeColor(c.color)}"></label>
        <label>镜头<select data-lens>${Object.keys(LENS).map(f=>`<option value="${f}" ${lensOf(c)===f?'selected':''}>${f} mm</option>`).join('')}<option value="custom" ${lensOf(c)==='custom'?'selected':''}>自定义</option></select></label>
        <label class="full chk"><input data-k="hidden" type="checkbox" ${c.hidden?'checked':''}> 在画布中隐藏</label>
      </div>`;
      cf.querySelectorAll('[data-k]').forEach(inp=>{
        inp.oninput=()=>{
          const k=inp.dataset.k;
          if(k==='hidden') c.hidden=inp.checked;
          else c[k]= (k==='name'||k==='zoneId'||k==='color') ? inp.value : (+inp.value||0);
          if((k==='hf'||k==='vf') && c.lens && c.lens!=='custom'){
            const l=LENS[c.lens];
            if(!l || Math.abs(c.hf-l[0])>=0.6 || Math.abs(c.vf-l[1])>=0.6) c.lens='custom';
          }
          const sel=cf.querySelector('[data-lens]');
          if(sel) sel.value=lensOf(c);
          saveState(); renderLists(); drawAll();
        };
      });
      cf.querySelector('[data-lens]').onchange=e=>{
        const f=e.target.value;
        if(f==='custom') c.lens='custom';
        else { const [h,v]=LENS[f]; c.hf=h; c.vf=v; c.lens=f; }
        saveState(); renderLists(); renderForms(); drawAll();
      };
    }
    const zf=$('zoneForm'), z=S.zones.find(x=>x.id===S.selZone);
    if(!z){zf.classList.add('hidden');zf.innerHTML='';}
    else{
      zf.classList.remove('hidden');
      zf.innerHTML=`<div class="grid">
        <label class="full">名称<input data-zk="name" type="text" value="${esc(z.name)}"></label>
        <label>X0<input data-zk="x0" type="number" step="0.1" value="${z.x0}"></label>
        <label>Y0<input data-zk="y0" type="number" step="0.1" value="${z.y0}"></label>
        <label>长<input data-zk="w" type="number" step="0.1" value="${z.w}"></label>
        <label>宽<input data-zk="h" type="number" step="0.1" value="${z.h}"></label>
        <label>颜色<input data-zk="color" type="color" value="${safeColor(z.color,'#d97706')}"></label>
        <label class="full chk"><input data-zk="hidden" type="checkbox" ${z.hidden?'checked':''}> 在画布中隐藏</label>
      </div>`;
      zf.querySelectorAll('[data-zk]').forEach(inp=>{
        inp.oninput=()=>{
          const k=inp.dataset.zk;
          if(k==='hidden') z.hidden=inp.checked;
          else z[k]= (k==='name'||k==='color') ? inp.value : (+inp.value||0);
          saveState(); renderLists(); drawAll();
        };
      });
    }
  }

  // ---------- 操作 ----------
  function addCamAt(x,y){
    const n=S.cams.length;
    const c={id:'c'+nextCam++, name:'C'+nextCam, x,y, h:3, hf:70, vf:35, pw:2560, ph:1440,
             yaw:0, pitch:30, roll:0, zoneId:'auto', color:COLORS[n%COLORS.length], lens:'4'};
    c.name='C'+(S.cams.length+1);
    S.cams.push(c); S.selCam=c.id; S.selZone=null;
    saveState(); renderLists(); renderForms(); drawAll();
  }
  function addZoneRect(x0,y0,w,h){
    if(w<0.5||h<0.5) return;
    const z={id:'z'+nextZone++, name:'区 '+(S.zones.length+1), x0:Math.min(x0,x0+w), y0:Math.min(y0,y0+h),
             w:Math.abs(w), h:Math.abs(h), color:'#d97706'};
    S.zones.push(z); S.selZone=z.id; S.selCam=null;
    saveState(); renderLists(); renderForms(); drawAll();
  }
  function distToZone(c,z){
    const r=zoneRect(z);
    const dx=Math.max(r[0]-c.x,0,c.x-r[2]);
    const dy=Math.max(r[1]-c.y,0,c.y-r[3]);
    return Math.hypot(dx,dy);
  }
  function autoAssign(){
    for(const c of S.cams){
      if(c.zoneId!=='auto') continue;
      let best=null, bestD=Infinity;
      for(const z of S.zones){
        const d=distToZone(c,z);
        if(d<bestD-1e-9){bestD=d;best=z;}
      }
      if(best) c.zoneId=best.id;
    }
    saveState(); renderLists(); renderForms(); drawAll();
    $('optMsg').textContent='已按最近距离自动分配监控区（可手动改）';
  }
  function optimizeSelected(){
    const c=S.cams.find(x=>x.id===S.selCam);
    if(!c){ $('optMsg').textContent='请先在列表或平面图中选中一台相机'; return; }
    if(!S.zones.length){ $('optMsg').textContent='请先画监控区'; return; }
    $('optMsg').textContent='计算中…';
    setTimeout(()=>{
      let z=S.zones.find(x=>x.id===c.zoneId);
      if(!z){
        let best=null,bestD=Infinity;
        for(const zz of S.zones){ const d=distToZone(c,zz); if(d<bestD){bestD=d;best=zz;} }
        z=best; if(!z){ $('optMsg').textContent='没有可用的监控区'; return; }
        c.zoneId=z.id;
      }
      const r=zoneRect(z), zA=((r[2]-r[0])*(r[3]-r[1]))||1;
      const test=(yaw,pitch,roll)=>{
        const cc={...c,yaw,pitch,roll};
        const fp=footprint(cc); if(!fp) return null;
        const inter=clipPoly(fp,r);
        const interA=inter.length>2?polyArea(inter):0;
        const fpA=polyArea(fp);
        const cov=interA/zA;
        // 视界利用率：监控区内覆盖面积 / 地面足迹面积
        const ratio=fpA>1e-9?Math.min(1,interA/fpA):0;
        return {cov,ratio,area:fpA};
      };
      // 覆盖率优先；覆盖率相同（含 100%）时，视界利用率越高越好
      const better=(t,b)=>!b || t.cov>b.cov+1e-6 ||
        (Math.abs(t.cov-b.cov)<=1e-6 && t.ratio>b.ratio+1e-9);
      // 粗扫：记录所有可行姿态
      const all=[];
      for(let yaw=0;yaw<360;yaw+=6)
        for(let pitch=1;pitch<=89;pitch+=2.5)
          for(let roll=0;roll<360;roll+=15){
            const t=test(yaw,pitch,roll); if(!t) continue;
            all.push({yaw,pitch,roll,...t});
          }
      let best=null;
      if(all.length){
        const topCov=all.reduce((a,b)=>b.cov>a.cov?b:a);
        const maxCov=topCov.cov;
        // 候选带：覆盖率接近最高值，按视界利用率排序，取彼此分散的起点
        const cands=all.filter(t=>t.cov>=maxCov-1e-3).sort((a,b)=>b.ratio-a.ratio);
        const picks=[];
        for(const s of cands){
          if(picks.length>=6) break;
          if(picks.every(p=>Math.abs(((p.yaw-s.yaw+540)%360)-180)>=15)) picks.push(s);
        }
        if(!picks.some(p=>p===topCov)) picks.push(topCov);
        // 多起点局部细化
        for(const s of picks){
          const b0={...s};
          let b={...s};
          for(let yaw=b0.yaw-6;yaw<=b0.yaw+6;yaw+=0.5)
            for(let pitch=Math.max(0.5,b0.pitch-2.5);pitch<=Math.min(89.5,b0.pitch+2.5);pitch+=0.25)
              for(let roll=b0.roll-15;roll<=b0.roll+15;roll+=1){
                const t=test(yaw,pitch,roll); if(!t) continue;
                if(better(t,b)) b={yaw,pitch,roll,...t};
              }
          if(better(b,best)) best=b;
        }
      }
      if(best){
        c.yaw=((best.yaw%360)+360)%360;
        c.pitch=best.pitch;
        c.roll=((best.roll%360)+360)%360;
        saveState(); renderLists(); renderForms(); drawAll();
        $('optMsg').textContent=`已优化「${c.name}」：覆盖 ${(best.cov*100).toFixed(0)}% · 视界利用率 ${(best.ratio*100).toFixed(0)}%`;
      } else {
        $('optMsg').textContent=`「${c.name}」无法覆盖「${z.name}」`;
      }
    },30);
  }

  // ---------- 指标 ----------
  function metrics(){
    const box=$('metrics');
    if(!S.zones.length){ box.innerHTML='<h3>覆盖指标</h3><div class="hint">先画监控区。</div>'; return; }
    const step=0.2;
    let totalA=0, coveredA=0, overA=0;
    const rows=[];
    const fps=S.cams.map(c=>footprint(c)).filter(Boolean);
    for(const z of S.zones){
      const r=zoneRect(z);
      const nx=Math.max(1,Math.round((r[2]-r[0])/step)), ny=Math.max(1,Math.round((r[3]-r[1])/step));
      let tot=0,cov=0,ov=0;
      for(let i=0;i<nx;i++)for(let j=0;j<ny;j++){
        const x=r[0]+(i+0.5)*(r[2]-r[0])/nx, y=r[1]+(j+0.5)*(r[3]-r[1])/ny;
        let k=0;
        for(const fp of fps){ if(insideConvex(fp,[x,y])) k++; }
        tot++; if(k>0)cov++; if(k>1)ov++;
      }
      const area=(r[2]-r[0])*(r[3]-r[1]);
      const cell=area/tot;
      totalA+=area; coveredA+=cov*cell; overA+=ov*cell;
      rows.push({name:z.name,area,cov:tot?cov/tot:0,ov:tot?ov/tot:0});
    }
    const pct=totalA?coveredA/totalA:0;
    // 视界利用率：区内覆盖面积 / 地面足迹面积。选中相机时看该相机，否则看全部加权值。
    const utilOf=c=>{
      const fp=footprint(c); if(!fp) return null;
      const fpA=polyArea(fp);
      let z=S.zones.find(x=>x.id===c.zoneId);
      if(!z){
        let bd=Infinity;
        for(const zz of S.zones){ const d=distToZone(c,zz); if(d<bd){ bd=d; z=zz; } }
      }
      if(!z) return {cov:0,fp:fpA};
      const inter=clipPoly(fp,zoneRect(z));
      return {cov:Math.min(fpA,inter.length>2?polyArea(inter):0),fp:fpA};
    };
    const selCam=S.cams.find(c=>c.id===S.selCam);
    let uCov=0,uFp=0;
    for(const c of (selCam?[selCam]:S.cams)){
      const u=utilOf(c); if(!u) continue;
      uCov+=u.cov; uFp+=u.fp;
    }
    const util=uFp>1e-9?uCov/uFp:0;
    box.innerHTML=`<h3>覆盖指标</h3>
      <div class="kpi">
        <div>监控区总面积<b>${totalA.toFixed(1)} ㎡</b></div>
        <div>已覆盖<b>${coveredA.toFixed(1)} ㎡</b></div>
        <div>覆盖率<b>${(pct*100).toFixed(0)}%</b></div>
        <div>视界利用率<b>${(util*100).toFixed(0)}%</b></div>
        <div>重叠面积<b>${overA.toFixed(1)} ㎡</b></div>
      </div>
      <table><thead><tr><th>监控区</th><th>面积</th><th>覆盖</th><th>重叠</th></tr></thead><tbody>
      ${rows.map(r=>`<tr><td>${esc(r.name)}</td><td>${r.area.toFixed(1)} ㎡</td><td><span class="tag ${r.cov>0.95?'t-ok':r.cov>0.5?'t-part':'t-none'}">${(r.cov*100).toFixed(0)}%</span></td><td>${(r.ov*100).toFixed(0)}%</td></tr>`).join('')}
      </tbody></table>
      <div class="hint">按 ${step} m 网格采样；覆盖率=被任意相机看到的面积/监控区面积。视界利用率=区内覆盖面积/地面足迹面积（选中相机时看该相机，否则为全部加权）。隐藏项仅影响画布显示，仍计入指标。</div>`;
  }

  function drawAll(){ fit3(); fitP(); draw3D(); drawPlan(); metrics(); }

  // ---------- 交互 ----------
  $('file').onchange=e=>{
    const f=e.target.files[0]; if(!f) return;
    const rd=new FileReader();
    rd.onload=()=>{
      const img=new Image();
      img.onload=()=>{
        S.img=img; S.imgW=img.naturalWidth; S.imgH=img.naturalHeight;
        S.planView={zoom:1,panX:0,panY:0}; S.imgX=0; S.imgY=0;
        $('imgX').value=0; $('imgY').value=0;
        S.mpp=Math.max(0.0005, S.mppW/S.imgW);
        S.view.dist=Math.max(20, Math.max(S.imgW*S.mpp, S.imgH*S.mpp)*1.7+8); S.view.tx=0; S.view.ty=0;
        $('mpp').value=S.mpp.toFixed(4);
        $('imgInfo').textContent=`${f.name} · ${S.imgW}×${S.imgH}px · ${(S.imgW*S.mpp).toFixed(2)}×${(S.imgH*S.mpp).toFixed(2)} m · 已存浏览器`;
        if(navigator.storage&&navigator.storage.persist) navigator.storage.persist().catch(()=>{});
        dbSet('plan',{dataUrl:rd.result,w:S.imgW,h:S.imgH,name:f.name});
        saveState(); drawAll();
      };
      img.src=rd.result;
    };
    rd.readAsDataURL(f);
  };
  $('imgX').oninput=$('imgY').oninput=()=>{
    S.imgX=+$('imgX').value||0; S.imgY=+$('imgY').value||0;
    saveState(); drawAll();
  };
  $('mppW').oninput=()=>{
    S.mppW=+$('mppW').value||14.5;
    if(S.imgW){ S.mpp=S.mppW/S.imgW; $('mpp').value=S.mpp.toFixed(4); saveState(); drawAll(); }
  };
  $('addCam').onclick=()=>{ S.mode='cam'; $('planBadge').textContent='点击平面图放置相机'; };
  $('addZone').onclick=()=>{ S.mode='zone'; $('planBadge').textContent='在平面图上拖出矩形'; };
  $('delCam').onclick=()=>{
    S.cams=S.cams.filter(c=>c.id!==S.selCam); S.selCam=null;
    saveState(); renderLists(); renderForms(); drawAll();
  };
  $('delZone').onclick=()=>{
    if(!S.selZone) return;
    const id=S.selZone;
    S.zones=S.zones.filter(z=>z.id!==id);
    for(const c of S.cams){ if(c.zoneId===id) c.zoneId='auto'; }
    S.selZone=null;
    saveState(); renderLists(); renderForms(); drawAll();
  };
  $('resetPlan').onclick=()=>{
    S.planView={zoom:1,panX:0,panY:0};
    drawPlan();
  };
  $('resetView').onclick=()=>{
    const [W,H]=extents();
    S.view={az:-90*D2R, el:55*D2R, dist:Math.max(20, Math.max(W,H)*1.7+8), tx:0, ty:0};
    draw3D();
  };
  function zoneCoverage(z){
    const r=zoneRect(z), step=0.2;
    const nx=Math.max(1,Math.round((r[2]-r[0])/step));
    const ny=Math.max(1,Math.round((r[3]-r[1])/step));
    const fps=S.cams.map(c=>footprint(c)).filter(Boolean);
    let tot=0,cov=0;
    for(let i=0;i<nx;i++)for(let j=0;j<ny;j++){
      const x=r[0]+(i+0.5)*(r[2]-r[0])/nx, y=r[1]+(j+0.5)*(r[3]-r[1])/ny;
      tot++;
      for(const fp of fps){ if(insideConvex(fp,[x,y])){cov++;break;} }
    }
    return tot?cov/tot:0;
  }
  async function loadDemo(){
    try{
      $('optMsg').textContent='加载示例…';
      const [cr,ir]=await Promise.all([
        fetch('pictures/example.json',{cache:'no-store'}),
        fetch('pictures/floorplan.png')
      ]);
      if(!cr.ok) throw new Error('未找到 pictures/example.json');
      if(!ir.ok) throw new Error('未找到 pictures/floorplan.png');
      const d=normalizeConfig(await cr.json());
      const b=await ir.blob();
      const dataUrl=await new Promise(res=>{const fr=new FileReader();fr.onload=()=>res(fr.result);fr.readAsDataURL(b);});
      const im=new Image();
      await new Promise((res,rej)=>{im.onload=res; im.onerror=rej; im.src=dataUrl;});
      S.img=im; S.imgW=im.naturalWidth; S.imgH=im.naturalHeight;
      S.mppW=d.mppW; S.mpp=d.mpp; S.imgX=d.imgX; S.imgY=d.imgY;
      S.cams=d.cams; S.zones=d.zones;
      nextCam=Math.max(0,...S.cams.map(c=>+String(c.id).replace(/\D/g,'')||0))+1;
      nextZone=Math.max(0,...S.zones.map(z=>+String(z.id).replace(/\D/g,'')||0))+1;
      S.selCam=null; S.selZone=null;
      S.planView={zoom:1,panX:0,panY:0};
      S.view={az:-90*D2R, el:55*D2R, dist:Math.max(16, Math.max(S.imgW*S.mpp,S.imgH*S.mpp)*1.35+5), tx:0, ty:0};
      $('mppW').value=S.mppW; $('mpp').value=(+S.mpp).toFixed(4);
      $('imgX').value=S.imgX; $('imgY').value=S.imgY;
      $('imgInfo').textContent='示例底图 · '+S.imgW+'×'+S.imgH+'px';
      dbSet('plan',{dataUrl,w:S.imgW,h:S.imgH,name:'示例底图'});
      saveState(); renderLists(); renderForms(); drawAll();
      $('optMsg').textContent='示例场景已加载';
    }catch(e){ $('optMsg').textContent='示例加载失败：'+e.message; }
  }
  $('demoBtn').onclick=loadDemo;
  $('exportList').onclick=()=>{
    const q=v=>{
      let t=String(v??'');
      if(/^[=+\-@\t\r]/.test(t)) t="'"+t;
      return '"'+t.replace(/"/g,'""')+'"';
    };
    const lines=[];
    lines.push(['编号','X (m)','Y (m)','高度 (m)','镜头','水平视角 (°)','垂直视角 (°)','分辨率','偏航 (°)','俯仰 (°)','滚转 (°)','负责监控区','区内覆盖','远端 px/m'].map(q).join(','));
    for(const c of S.cams){
      const z=S.zones.find(x=>x.id===c.zoneId);
      let cov='', ppf='';
      if(z){
        const fp=footprint(c), r=zoneRect(z);
        if(fp){
          const inter=clipPoly(fp,r);
          const a=inter.length>2?polyArea(inter):0;
          const za=(r[2]-r[0])*(r[3]-r[1]);
          cov=za?((a/za*100).toFixed(0)+'%'):'';
        }
        const cs=[[r[0],r[1]],[r[2],r[1]],[r[2],r[3]],[r[0],r[3]]];
        let d=0; for(const p of cs) d=Math.max(d,Math.hypot(p[0]-c.x,p[1]-c.y));
        ppf=camPPF(c,d).toFixed(0);
      }
      lines.push([c.name,c.x.toFixed(2),c.y.toFixed(2),c.h.toFixed(1),
        lensOf(c)==='custom'?'自定义':lensOf(c)+' mm',c.hf.toFixed(0),c.vf.toFixed(0),
        `${c.pw}×${c.ph}`,c.yaw.toFixed(0),c.pitch.toFixed(1),c.roll.toFixed(0),
        z?z.name:'未分配',cov,ppf].map(q).join(','));
    }
    lines.push('');
    lines.push(['监控区','面积 (㎡)','覆盖率'].map(q).join(','));
    for(const z of S.zones){
      const r=zoneRect(z); const a=(r[2]-r[0])*(r[3]-r[1]);
      lines.push([z.name,a.toFixed(1),(zoneCoverage(z)*100).toFixed(0)+'%'].map(q).join(','));
    }
    const csv='\ufeff'+lines.join('\r\n');
    const blob=new Blob([csv],{type:'text/csv;charset=utf-8'});
    const a=document.createElement('a');
    a.href=URL.createObjectURL(blob);
    a.download=`监控摄像机配置单-${new Date().toISOString().slice(0,10)}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(()=>URL.revokeObjectURL(a.href),1500);
    $('optMsg').textContent='配置单已导出（CSV，可用 Excel 打开）';
  };
  $('exportCfg').onclick=()=>{
    const data={app:'camera-fov-planner',version:1,mppW:S.mppW,mpp:S.mpp,imgX:S.imgX,imgY:S.imgY,
      cams:S.cams,zones:S.zones,
      image:S.img?{dataUrl:S.img.src,w:S.imgW,h:S.imgH}:null};
    const blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'});
    const a=document.createElement('a');
    a.href=URL.createObjectURL(blob);
    a.download=`监控规划-${new Date().toISOString().slice(0,10)}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(()=>URL.revokeObjectURL(a.href),1500);
    $('optMsg').textContent='配置已导出';
  };
  function normalizeConfig(d){
    if(!d||!Array.isArray(d.cams)||!Array.isArray(d.zones)) throw new Error('不是有效的配置文件');
    if(d.cams.length>200||d.zones.length>200) throw new Error('相机或监控区数量超过上限（200）');
    const num=(v,a,b,def)=>{v=+v; return Number.isFinite(v)?Math.min(b,Math.max(a,v)):def;};
    const uid=(v,prefix,i)=>/^[A-Za-z0-9_-]{1,24}$/.test(String(v||''))?String(v):prefix+i;
    const zids=new Set();
    const zones=d.zones.map((z,i)=>{
      let id=uid(z.id,'z',i+1); while(zids.has(id)) id+='x'; zids.add(id);
      return {id, name:String(z.name||('区 '+(i+1))).slice(0,60),
        x0:num(z.x0,-1e4,1e4,0), y0:num(z.y0,-1e4,1e4,0),
        w:num(z.w,0.1,1e4,4), h:num(z.h,0.1,1e4,3),
        color:safeColor(z.color,'#d97706'), hidden:!!z.hidden};
    });
    const cids=new Set();
    const cams=d.cams.map((c,i)=>{
      let id=uid(c.id,'c',i+1); while(cids.has(id)) id+='x'; cids.add(id);
      const zid=String(c.zoneId||'auto');
      return {id, name:String(c.name||('C'+(i+1))).slice(0,40),
        x:num(c.x,-1e4,1e4,0), y:num(c.y,-1e4,1e4,0), h:num(c.h,0.3,50,3),
        hf:num(c.hf,5,170,70), vf:num(c.vf,3,150,35),
        pw:Math.round(num(c.pw,320,8192,2560)), ph:Math.round(num(c.ph,240,4320,1440)),
        yaw:num(c.yaw,-720,720,0), pitch:num(c.pitch,0,90,30), roll:num(c.roll,-720,720,0),
        zoneId:zids.has(zid)?zid:'auto', color:safeColor(c.color), hidden:!!c.hidden,
        lens:['2.8','4','6','8','custom'].includes(String(c.lens))?String(c.lens):undefined};
    });
    return {mppW:num(d.mppW,0.2,5000,14.5), mpp:num(d.mpp,0.00001,2,0.01),
      imgX:num(d.imgX,-1e5,1e5,0), imgY:num(d.imgY,-1e5,1e5,0), zones, cams, image:d.image};
  }
  $('importCfg').onchange=e=>{
    const f=e.target.files[0]; if(!f) return;
    if(f.size>20*1024*1024){ $('optMsg').textContent='导入失败：文件超过 20 MB'; e.target.value=''; return; }
    const rd=new FileReader();
    rd.onload=()=>{
      try{
        const d=normalizeConfig(JSON.parse(rd.result));
        S.mppW=d.mppW; S.mpp=d.mpp; S.imgX=d.imgX; S.imgY=d.imgY;
        S.cams=d.cams; S.zones=d.zones;
        nextCam=Math.max(0,...S.cams.map(c=>+String(c.id).replace(/\D/g,'')||0))+1;
        nextZone=Math.max(0,...S.zones.map(z=>+String(z.id).replace(/\D/g,'')||0))+1;
        S.selCam=null; S.selZone=null; S.planView={zoom:1,panX:0,panY:0};
        const finish=()=>{
          saveState(); $('mppW').value=S.mppW; $('mpp').value=(+S.mpp).toFixed(4);
          $('imgX').value=S.imgX; $('imgY').value=S.imgY;
          renderLists(); renderForms(); drawAll();
          $('optMsg').textContent=`已导入 ${S.cams.length} 台相机、${S.zones.length} 个监控区`;
        };
        const dataUrl=d.image&&typeof d.image.dataUrl==='string'&&d.image.dataUrl.startsWith('data:image/')?d.image.dataUrl:null;
        if(dataUrl){
          const im=new Image();
          im.onload=()=>{
            S.img=im; S.imgW=im.naturalWidth; S.imgH=im.naturalHeight;
            S.view.dist=Math.max(20, Math.max(S.imgW*S.mpp,S.imgH*S.mpp)*1.7+8);
            S.view.tx=0; S.view.ty=0;
            dbSet('plan',{dataUrl,w:S.imgW,h:S.imgH,name:'导入'});
            $('imgInfo').textContent=`导入底图 · ${S.imgW}×${S.imgH}px`;
            finish();
          };
          im.onerror=()=>{ $('optMsg').textContent='导入失败：底图图片无法解析'; };
          im.src=dataUrl;
        } else finish();
      }catch(err){ $('optMsg').textContent='导入失败：'+err.message; }
    };
    rd.readAsText(f);
    e.target.value='';
  };
  $('showCams').onclick=()=>{
    for(const c of S.cams) c.hidden=false;
    saveState(); renderLists(); renderForms(); drawAll();
  };
  $('showZones').onclick=()=>{
    for(const z of S.zones) z.hidden=false;
    saveState(); renderLists(); renderForms(); drawAll();
  };
  $('autoAssign').onclick=autoAssign;
  $('optimize').onclick=optimizeSelected;

  cp.addEventListener('pointerdown',e=>{
    if(e.button===2||e.button===1||e.shiftKey){
      S.drag={type:'pan',x:e.clientX,y:e.clientY};
      cp.setPointerCapture(e.pointerId);
      return;
    }
    const r=cp.getBoundingClientRect();
    const sx=e.clientX-r.left, sy=e.clientY-r.top;
    const [wx,wy]=planToWorld(sx,sy);
    if(S.mode==='cam'){ addCamAt(wx,wy); S.mode=null; $('planBadge').textContent='平面 · 左键放置/拖动 · 右键平移 · 滚轮缩放'; return; }
    if(S.mode==='zone'){ S.drag={type:'zone',x0:wx,y0:wy,x1:wx,y1:wy}; cp.setPointerCapture(e.pointerId); return; }
    // 选中相机
    let hit=null;
    for(const c of S.cams){ if(Math.hypot(c.x-wx,c.y-wy)<1.2){ hit=c; break; } }
    if(hit){
      S.selCam=hit.id; S.selZone=null; S.drag={type:'cam',id:hit.id,dx:hit.x-wx,dy:hit.y-wy};
      cp.setPointerCapture(e.pointerId); renderLists(); renderForms(); drawAll(); return;
    }
    let zh=null;
    for(const z of S.zones){ const rr=zoneRect(z); if(wx>=rr[0]&&wx<=rr[2]&&wy>=rr[1]&&wy<=rr[3]){zh=z;break;} }
    if(zh){ S.selZone=zh.id; S.selCam=null; renderLists(); renderForms(); drawAll(); }
  });
  cp.addEventListener('pointermove',e=>{
    if(!S.drag) return;
    if(S.drag.type==='pan'){
      S.planView.panX+=(e.clientX-S.drag.x);
      S.planView.panY+=(e.clientY-S.drag.y);
      S.drag.x=e.clientX; S.drag.y=e.clientY;
      drawPlan();
      return;
    }
    const r=cp.getBoundingClientRect();
    const [wx,wy]=planToWorld(e.clientX-r.left,e.clientY-r.top);
    if(S.drag.type==='cam'){
      const c=S.cams.find(x=>x.id===S.drag.id);
      if(c){ c.x=wx+S.drag.dx; c.y=wy+S.drag.dy; saveState(); drawAll(); }
    } else {
      S.drag.x1=wx; S.drag.y1=wy; drawAll();
      // 临时矩形
      const x0=Math.min(S.drag.x0,wx), y0=Math.min(S.drag.y0,wy);
      const w=Math.abs(wx-S.drag.x0), h=Math.abs(wy-S.drag.y0);
      const a=planT?[planT.cx+(x0-planT.cX)*planT.s, planT.cy-(y0+h-planT.cY)*planT.s]:[0,0];
      const b=planT?[planT.cx+(x0+w-planT.cX)*planT.s, planT.cy-(y0-planT.cY)*planT.s]:[0,0];
      xp.setLineDash([5,4]); xp.strokeStyle='#d97706'; xp.lineWidth=1.5; xp.strokeRect(a[0],a[1],b[0]-a[0],b[1]-a[1]); xp.setLineDash([]);
    }
  });
  cp.addEventListener('wheel',e=>{
    e.preventDefault();
    if(!planT) return;
    const r=cp.getBoundingClientRect();
    const mx=e.clientX-r.left, my=e.clientY-r.top;
    const {s,cx,cy,cX,cY}=planT;
    const wx=cX+(mx-cx)/s, wy=cY-(my-cy)/s;
    const pv=S.planView;
    const z=Math.max(0.35,Math.min(12,pv.zoom*(1-Math.sign(e.deltaY)*0.12)));
    const base=s/pv.zoom, s2=base*z;
    pv.zoom=z;
    pv.panX=mx-WP/2-(wx-cX)*s2;
    pv.panY=my-HP/2+(wy-cY)*s2;
    drawPlan();
  },{passive:false});
  cp.addEventListener('contextmenu',e=>e.preventDefault());

  cp.addEventListener('pointerup',e=>{
    if(!S.drag) return;
    if(S.drag.type==='zone'){
      const x0=Math.min(S.drag.x0,S.drag.x1), y0=Math.min(S.drag.y0,S.drag.y1);
      const w=Math.abs(S.drag.x1-S.drag.x0), h=Math.abs(S.drag.y1-S.drag.y0);
      addZoneRect(x0,y0,w,h);
      S.mode=null; $('planBadge').textContent='平面 · 左键放置/拖动 · 右键平移 · 滚轮缩放';
    }
    S.drag=null;
  });

  // 3D 旋转 / 平移 / 缩放
  let drag3=null;
  c3d.addEventListener('contextmenu',e=>e.preventDefault());
  c3d.addEventListener('pointerdown',e=>{
    const pan=(e.button===2||e.button===1||e.shiftKey);
    drag3={x:e.clientX,y:e.clientY,pan};
    c3d.setPointerCapture(e.pointerId);
  });
  c3d.addEventListener('pointermove',e=>{
    if(!drag3) return;
    const dx=e.clientX-drag3.x, dy=e.clientY-drag3.y;
    drag3={...drag3,x:e.clientX,y:e.clientY};
    if(drag3.pan){
      const t=target(), {az,el,dist}=S.view;
      const eye=[t[0]+dist*Math.cos(el)*Math.cos(az), t[1]+dist*Math.cos(el)*Math.sin(az), t[2]+dist*Math.sin(el)];
      const fwd=norm(sub(t,eye));
      let right=cross(fwd,[0,0,1]);
      if(Math.hypot(right[0],right[1],right[2])<1e-6) right=[1,0,0];
      right=norm(right);
      let fg=[fwd[0],fwd[1],0];
      if(Math.hypot(fg[0],fg[1])<1e-6) fg=[0,1,0]; else fg=norm(fg);
      const k=2*dist*Math.tan(45*D2R/2)/H3;
      S.view.tx=(S.view.tx||0)+(-right[0]*dx+fg[0]*dy)*k;
      S.view.ty=(S.view.ty||0)+(-right[1]*dx+fg[1]*dy)*k;
    } else {
      S.view.az-=dx*0.008;
      S.view.el=Math.max(0.08,Math.min(Math.PI/2,S.view.el+dy*0.006));
    }
    draw3D();
  });
  c3d.addEventListener('pointerup',()=>drag3=null);
  c3d.addEventListener('wheel',e=>{
    e.preventDefault();
    S.view.dist=Math.max(6,Math.min(120,S.view.dist*(1+Math.sign(e.deltaY)*0.08)));
    draw3D();
  },{passive:false});

  window.addEventListener('resize',drawAll);

  function hexA(hex,a){
    const h=hex.replace('#','');
    const n=parseInt(h.length===3?h.split('').map(c=>c+c).join(''):h,16);
    return `rgba(${(n>>16)&255},${(n>>8)&255},${n&255},${a})`;
  }



  // ---------- 启动 ----------
  (async()=>{
    loadState();
    const rec=await dbGet('plan');
    if(rec && rec.dataUrl){
      const img=new Image();
      img.onload=()=>{
        S.img=img; S.imgW=img.naturalWidth; S.imgH=img.naturalHeight;
        S.planView={zoom:1,panX:0,panY:0};
        S.mpp=S.mppW/S.imgW;
        S.view.dist=Math.max(20, Math.max(S.imgW*S.mpp, S.imgH*S.mpp)*1.7+8); S.view.tx=0; S.view.ty=0;
        $('mpp').value=S.mpp.toFixed(4);
        $('imgInfo').textContent=`${rec.name||'已保存底图'} · ${S.imgW}×${S.imgH}px · ${(S.imgW*S.mpp).toFixed(2)}×${(S.imgH*S.mpp).toFixed(2)} m · 已从浏览器恢复`;
        drawAll();
      };
      img.src=rec.dataUrl;
    }
    $('mppW').value=S.mppW;
    $('imgX').value=S.imgX; $('imgY').value=S.imgY;
    renderLists(); renderForms(); drawAll();
  })();
})();
