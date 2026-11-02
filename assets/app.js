(() => {
  const $ = id => document.getElementById(id);
  const {D2R,R2D,vec}=Geo;
  const {sub,dot,cross,norm}=vec;

  const S = {
    hf:94, vf:49, pw:2560, ph:1440, hh:5, pt:90, yw:0, roll:90,
    zone:{x0:0,y0:0,x1:8,y1:4,on:true},
    view:{az:90*D2R, el:60*D2R, dist:30, target:[0,0,1.2]},
    userZoom:false
  };

  // ---------- 参数持久化（cookie + localStorage 兜底） ----------
  const COOKIE='camview';
  function saveState(){
    const o={hf:S.hf,vf:S.vf,pw:S.pw,ph:S.ph,hh:S.hh,pt:S.pt,yw:S.yw,roll:S.roll,
             zx0:S.zone.x0,zy0:S.zone.y0,zx1:S.zone.x1,zy1:S.zone.y1,zon:S.zone.on?1:0};
    const v=encodeURIComponent(JSON.stringify(o));
    document.cookie=COOKIE+'='+v+'; max-age=31536000; path=/; SameSite=Lax';
    try{ localStorage.setItem(COOKIE,v); }catch(e){}
  }
  let saveTimer=null;
  function scheduleSave(){ clearTimeout(saveTimer); saveTimer=setTimeout(saveState,300); }
  function loadState(){
    let raw=null;
    const m=document.cookie.match(new RegExp('(?:^|; )'+COOKIE+'=([^;]*)'));
    if(m) raw=m[1];
    if(!raw){ try{ raw=localStorage.getItem(COOKIE); }catch(e){} }
    if(!raw) return;
    try{
      const o=JSON.parse(decodeURIComponent(raw));
      const n=(v,a,b,d)=>{v=+v; return Number.isFinite(v)?Math.min(b,Math.max(a,v)):d;};
      S.hf=n(o.hf,10,150,94); S.vf=n(o.vf,5,120,49);
      S.pw=n(o.pw,320,4096,2560); S.ph=n(o.ph,240,2160,1440);
      S.hh=n(o.hh,1,20,5); S.pt=n(o.pt,0,90,90); S.yw=n(o.yw,0,360,0); S.roll=n(o.roll,0,360,90);
      const x0=n(o.zx0,-999,999,0), y0=n(o.zy0,-999,999,0), x1=n(o.zx1,-999,999,8), y1=n(o.zy1,-999,999,4);
      S.zone={x0,y0,x1:Math.max(x0+0.5,x1),y1:Math.max(y0+0.5,y1),on:o.zon!==0};
    }catch(e){}
  }
  loadState();

  // ---------- 几何 ----------
  function geometry(){
    const h=S.hh;
    const {axis,right,up,tH,tV,th,ph}=Geo.basis({hf:S.hf,vf:S.vf,yaw:S.yw,pitch:S.pt,roll:S.roll});
    const rays=[]; const pts=[]; let valid=true;
    for (const v of [-1,1]) for (const u of [-1,1]) {
      const d=[axis[0]+u*tH*right[0]+v*tV*up[0],
               axis[1]+u*tH*right[1]+v*tV*up[1],
               axis[2]+u*tH*right[2]+v*tV*up[2]];
      rays.push(d);
      if (d[2] >= -1e-6){ valid=false; pts.push(null); }
      else { const t=h/(-d[2]); pts.push([d[0]*t,d[1]*t,0]); }
    }
    // 顺序：(-,-),(+,-),(+,+),(-,+)  ->  0,1,3,2
    const poly=[pts[0],pts[1],pts[3],pts[2]];
    let near=null, far=null, nearPt=null, farPt=null;
    if(valid){
      if(insideConvex(poly,[0,0])){
        near=0; nearPt=[0,0];
      } else {
        // 近端：原点到四边形边界的最短距离
        let best=Infinity;
        for(let i=0;i<4;i++){
          const a=poly[i], b=poly[(i+1)%4];
          const abx=b[0]-a[0], aby=b[1]-a[1];
          const L2=abx*abx+aby*aby || 1;
          const t=Math.max(0,Math.min(1,-(a[0]*abx+a[1]*aby)/L2));
          const px=a[0]+abx*t, py=a[1]+aby*t;
          const d=Math.hypot(px,py);
          if(d<best){best=d;nearPt=[px,py];}
        }
        near=best;
      }
      let bf=-1;
      for(const p of poly){const d=Math.hypot(p[0],p[1]); if(d>bf){bf=d;farPt=p;}}
      far=bf;
    } else {
      near=(S.pt+S.vf/2<90)?h/Math.tan((S.pt+S.vf/2)*D2R):0;
      far=Infinity;
    }
    let area=null;
    if (valid){
      let a=0;
      for(let i=0;i<4;i++){const p=poly[i],q=poly[(i+1)%4]; a+=p[0]*q[1]-q[0]*p[1];}
      area=Math.abs(a)/2;
    }
    return {h,th,ph,axis,right,up,rays,poly,valid,near,far,nearPt,farPt,area,apex:[0,0,h]};
  }

  const ppf = (dist) => Geo.ppf(S.pw,S.hf,S.hh,dist); // dist: 地面距离
  const distFor = (target) => { // 达到某 px/m 的地面距离；不可达返回 null
    const slant=S.pw/(2*target*Math.tan(S.hf/2*D2R));
    return slant>S.hh+1e-6 ? Math.sqrt(slant*slant-S.hh*S.hh) : null;
  };
  const level = p => p>=250?['识别','t-id']:p>=125?['辨认','t-rec']:p>=62.5?['观察','t-obs']:p>=25?['发现','t-det']:['不足','t-none'];

  // ---------- 监控范围矩形 ----------
  const zoneRect = () => [S.zone.x0,S.zone.y0,S.zone.x1,S.zone.y1];
  const {clipPoly,polyArea,insideConvex}=Geo;
  const zoneInter = g => g.valid ? clipPoly(g.poly, zoneRect()) : [];

  function footprintFor(yawDeg,pitchDeg,rollDeg){
    return Geo.footprint({x:0,y:0,h:S.hh,hf:S.hf,vf:S.vf,
      yaw:yawDeg,pitch:pitchDeg,roll:rollDeg===undefined?S.roll:rollDeg}, -1e-6);
  }
  function setParams(yaw,pitch,roll){
    yaw=((yaw%360)+360)%360; roll=((roll%360)+360)%360;
    S.yw=yaw; S.pt=pitch; S.roll=roll;
    $('yw').value=yaw; $('ywN').value=+yaw.toFixed(1); $('ywV').textContent=yaw.toFixed(0);
    $('pt').value=pitch; $('ptN').value=+pitch.toFixed(1); $('ptV').textContent=pitch.toFixed(1);
    $('rl').value=roll; $('rlN').value=+roll.toFixed(1); $('rlV').textContent=roll.toFixed(0);
    render();
  }
  function optimize(){
    const z=S.zone;
    const zc=[[z.x0,z.y0],[z.x1,z.y0],[z.x1,z.y1],[z.x0,z.y1]];
    const zArea=Math.max(1e-6,(z.x1-z.x0)*(z.y1-z.y0));
    const test=(yaw,pitch,roll)=>{
      const fp=footprintFor(yaw,pitch,roll);
      if(!fp) return null;
      for(const c of zc){ if(!insideConvex(fp,c)) return null; }
      return polyArea(fp);
    };
    let best=null;
    // 粗扫：偏航 5°、俯仰 2°、滚转 10°
    for(let yaw=0;yaw<360;yaw+=5){
      for(let pitch=1;pitch<=89;pitch+=2){
        for(let roll=0;roll<360;roll+=10){
          const a=test(yaw,pitch,roll);
          if(a!==null && (!best || a<best.a)) best={yaw,pitch,roll,a};
        }
      }
    }
    // 细化
    if(best){
      const b0={...best};
      for(let yaw=b0.yaw-5;yaw<=b0.yaw+5;yaw+=0.5){
        for(let pitch=Math.max(0.5,b0.pitch-2);pitch<=Math.min(89.5,b0.pitch+2);pitch+=0.25){
          for(let roll=b0.roll-10;roll<=b0.roll+10;roll+=1){
            const a=test(yaw,pitch,roll);
            if(a!==null && a<best.a) best={yaw,pitch,roll,a};
          }
        }
      }
    }
    if(best){
      const yaw=((best.yaw%360)+360)%360, roll=((best.roll%360)+360)%360;
      setParams(yaw,best.pitch,roll);
      const ratio=zArea/best.a*100;
      $('optResult').textContent=`偏航 ${yaw.toFixed(1)}° / 俯仰 ${best.pitch.toFixed(1)}° / 滚转 ${roll.toFixed(0)}°；范围占视界 ${ratio.toFixed(1)}%`;
    } else {
      // 无法全覆盖：退而求覆盖面积最大
      let bc={cov:-1,yaw:0,pitch:45,roll:0};
      for(let yaw=0;yaw<360;yaw+=10){
        for(let pitch=2;pitch<=89;pitch+=3){
          for(let roll=0;roll<360;roll+=15){
            const fp=footprintFor(yaw,pitch,roll);
            if(!fp) continue;
            const inter=clipPoly(fp,[z.x0,z.y0,z.x1,z.y1]);
            const cov=inter.length>2?polyArea(inter)/zArea:0;
            if(cov>bc.cov) bc={cov,yaw,pitch,roll};
          }
        }
      }
      const yaw=((bc.yaw%360)+360)%360, roll=((bc.roll%360)+360)%360;
      setParams(yaw,bc.pitch,roll);
      $('optResult').textContent=`无法完全覆盖；最佳覆盖 ${(bc.cov*100).toFixed(0)}%（偏航 ${yaw.toFixed(0)}° / 俯仰 ${bc.pitch.toFixed(0)}° / 滚转 ${roll.toFixed(0)}°）`;
    }
  }

  // ---------- 3D ----------
  const c3d=$('c3d'), x3=c3d.getContext('2d');
  let W3=0,H3=0,DPR=1;
  function fit3(){
    const r=c3d.getBoundingClientRect(); DPR=window.devicePixelRatio||1;
    W3=Math.max(10,r.width); H3=Math.max(10,r.height);
    c3d.width=Math.round(W3*DPR); c3d.height=Math.round(H3*DPR);
    x3.setTransform(DPR,0,0,DPR,0,0);
  }

  function cameraBasis(){
    const {az,el,dist}=S.view;
    const target=[S.view.target[0]+(S.view.tx||0),S.view.target[1]+(S.view.ty||0),S.view.target[2]];
    const eye=[target[0]+dist*Math.cos(el)*Math.cos(az),
               target[1]+dist*Math.cos(el)*Math.sin(az),
               target[2]+dist*Math.sin(el)];
    const fwd=norm(sub(target,eye));
    let right=cross(fwd,[0,0,1]);
    if(Math.hypot(right[0],right[1],right[2])<1e-6) right=[1,0,0];
    right=norm(right);
    const up=cross(right,fwd);
    return {eye,fwd,right,up,target};
  }
  function projector(){
    const {az,el,dist}=S.view;
    const target=[S.view.target[0]+(S.view.tx||0),S.view.target[1]+(S.view.ty||0),S.view.target[2]];
    return Geo.makeProjector({w:W3,h:H3,target,az,el,dist,nearZ:0.15,withDepth:true});
  }

  function draw3D(){
    const g=geometry(), pr=projector();
    x3.clearRect(0,0,W3,H3);
    const azDeg=(((S.view.az*R2D)%360)+360)%360;
    $('viewAng').textContent=`方位 ${azDeg.toFixed(0)}° · 仰角 ${(S.view.el*R2D).toFixed(0)}°`;
    // 背景
    const grad=x3.createLinearGradient(0,0,0,H3);
    grad.addColorStop(0,'#fbfcfe'); grad.addColorStop(1,'#eef2f7');
    x3.fillStyle=grad; x3.fillRect(0,0,W3,H3);

    // 地面网格
    let mR=10;
    if(g.valid) for(const p of g.poly) mR=Math.max(mR, Math.hypot(p[0],p[1]));
    const R=Math.max(24, Math.ceil(mR/5)*5+5);
    x3.lineWidth=1;
    for(let i=-R;i<=R;i++){
      const major=i%5===0;
      x3.strokeStyle=major?'#d7dde6':'#e9edf2';
      let a=pr([i,-R,0]), b=pr([i,R,0]);
      if(a&&b){x3.beginPath();x3.moveTo(a[0],a[1]);x3.lineTo(b[0],b[1]);x3.stroke();}
      a=pr([-R,i,0]); b=pr([R,i,0]);
      if(a&&b){x3.beginPath();x3.moveTo(a[0],a[1]);x3.lineTo(b[0],b[1]);x3.stroke();}
    }

    const apex=pr(g.apex);
    const poly=g.poly.map(p=>p?pr(p):null);

    // 监控范围矩形
    if(S.zone.on){
      const z=S.zone;
      const zp=[[z.x0,z.y0],[z.x1,z.y0],[z.x1,z.y1],[z.x0,z.y1]].map(p=>pr([p[0],p[1],0]));
      if(zp.every(Boolean)){
        x3.beginPath(); zp.forEach((p,i)=> i?x3.lineTo(p[0],p[1]):x3.moveTo(p[0],p[1])); x3.closePath();
        x3.fillStyle='rgba(245,158,11,.10)'; x3.fill();
        x3.setLineDash([7,5]); x3.strokeStyle='rgba(217,119,6,.95)'; x3.lineWidth=1.6; x3.stroke();
        x3.setLineDash([]);
      }
    }

    // 足迹
    if(g.valid && poly.every(Boolean)){
      x3.beginPath();
      poly.forEach((p,i)=> i?x3.lineTo(p[0],p[1]):x3.moveTo(p[0],p[1]));
      x3.closePath();
      x3.fillStyle='rgba(47,111,237,.16)';
      x3.fill();
      x3.strokeStyle='rgba(47,111,237,.85)';
      x3.lineWidth=2; x3.stroke();
    }

    // 监控范围内的覆盖（交集）
    if(S.zone.on){
      const inter=zoneInter(g);
      if(inter.length>2){
        const ip=inter.map(p=>pr([p[0],p[1],0]));
        if(ip.every(Boolean)){
          x3.beginPath(); ip.forEach((p,i)=> i?x3.lineTo(p[0],p[1]):x3.moveTo(p[0],p[1])); x3.closePath();
          x3.fillStyle='rgba(217,119,6,.35)'; x3.fill();
          x3.strokeStyle='rgba(180,83,9,.9)'; x3.lineWidth=1.4; x3.stroke();
        }
      }
    }

    // 四棱锥侧面 + 棱
    if(apex && g.valid){
      for(let i=0;i<4;i++){
        const a=pr(g.poly[i]), b=pr(g.poly[(i+1)%4]);
        if(!a||!b) continue;
        x3.beginPath(); x3.moveTo(apex[0],apex[1]); x3.lineTo(a[0],a[1]); x3.lineTo(b[0],b[1]); x3.closePath();
        x3.fillStyle='rgba(47,111,237,.055)';
        x3.fill();
      }
      x3.strokeStyle='rgba(37,86,180,.55)'; x3.lineWidth=1.4;
      for(let i=0;i<4;i++){
        const p=pr(g.poly[i]); if(!p) continue;
        x3.beginPath(); x3.moveTo(apex[0],apex[1]); x3.lineTo(p[0],p[1]); x3.stroke();
      }
    }
    // 远端越界：画射线示意
    if(apex && !g.valid){
      x3.setLineDash([5,5]); x3.strokeStyle='rgba(37,86,180,.45)'; x3.lineWidth=1.3;
      for(const dvec of g.rays){
        const L=40/Math.hypot(dvec[0],dvec[1],dvec[2]);
        const p=pr([g.apex[0]+dvec[0]*L, g.apex[1]+dvec[1]*L, g.apex[2]+dvec[2]*L]);
        if(!p) continue;
        x3.beginPath(); x3.moveTo(apex[0],apex[1]); x3.lineTo(p[0],p[1]); x3.stroke();
      }
      x3.setLineDash([]);
    }

    // 光轴
    if(g.valid && g.far!==Infinity){
      const t=S.hh/Math.tan(g.th);
      const gp=pr([Math.cos(g.ph)*t, Math.sin(g.ph)*t, 0]);
      if(apex&&gp){
        x3.setLineDash([6,5]); x3.strokeStyle='rgba(30,60,120,.6)'; x3.lineWidth=1.2;
        x3.beginPath(); x3.moveTo(apex[0],apex[1]); x3.lineTo(gp[0],gp[1]); x3.stroke();
        x3.setLineDash([]);
      }
    }

    // 高度线
    const base=pr([0,0,0]);
    if(apex&&base){
      x3.setLineDash([3,4]); x3.strokeStyle='#94a3b8'; x3.lineWidth=1.2;
      x3.beginPath(); x3.moveTo(apex[0],apex[1]); x3.lineTo(base[0],base[1]); x3.stroke();
      x3.setLineDash([]);
      x3.fillStyle='#64748b'; x3.font='12px sans-serif'; x3.textAlign='right';
      x3.fillText(`h=${S.hh.toFixed(1)} m`, base[0]-8, (apex[1]+base[1])/2);
    }

    // 相机
    if(apex){
      x3.beginPath(); x3.arc(apex[0],apex[1],7,0,Math.PI*2);
      x3.fillStyle='#111827'; x3.fill();
      x3.beginPath(); x3.arc(apex[0],apex[1],11,0,Math.PI*2);
      x3.strokeStyle='rgba(17,24,39,.25)'; x3.lineWidth=2; x3.stroke();
    }

    // 近/远标注
    if(g.valid && g.far!==Infinity && g.nearPt && g.farPt){
      const a=pr([g.nearPt[0],g.nearPt[1],0]), b=pr([g.farPt[0],g.farPt[1],0]);
      x3.font='12px sans-serif'; x3.textAlign='center';
      if(a){x3.fillStyle='#1e3a8a'; x3.beginPath(); x3.arc(a[0],a[1],3.5,0,7); x3.fill();
            x3.fillText(`近 ${g.near.toFixed(1)} m`,a[0],a[1]+18);}
      if(b){x3.fillStyle='#1e3a8a'; x3.beginPath(); x3.arc(b[0],b[1],3.5,0,7); x3.fill();
            x3.fillText(`远 ${g.far.toFixed(1)} m`,b[0],b[1]+18);}
    }
  }

  // ---------- 平面图 ----------
  const cp=$('cplan'), xp=cp.getContext('2d');
  let WP=0,HP=0, planView=null, zoneDrag=null;
  function fitP(){
    const r=cp.getBoundingClientRect(); const dpr=window.devicePixelRatio||1;
    WP=Math.max(10,r.width); HP=Math.max(10,r.height);
    cp.width=Math.round(WP*dpr); cp.height=Math.round(HP*dpr);
    xp.setTransform(dpr,0,0,dpr,0,0);
  }
  function drawPlan(){
    const g=geometry();
    xp.clearRect(0,0,WP,HP);
    xp.fillStyle='#fbfcfe'; xp.fillRect(0,0,WP,HP);

    // 自动适配（以足迹包围盒居中）
    let pts=[[0,0]];
    if(g.valid) pts=pts.concat(g.poly.map(p=>[p[0],p[1]]));
    let minx=Infinity,maxx=-Infinity,miny=Infinity,maxy=-Infinity;
    for(const p of pts){minx=Math.min(minx,p[0]);maxx=Math.max(maxx,p[0]);miny=Math.min(miny,p[1]);maxy=Math.max(maxy,p[1]);}
    const c0=[(minx+maxx)/2,(miny+maxy)/2];
    let maxR=0;
    for(const p of pts) maxR=Math.max(maxR,Math.hypot(p[0]-c0[0],p[1]-c0[1]));
    maxR=Math.min(Math.max(maxR*1.18,6),80);
    const s=Math.min(WP,HP)/(2*maxR)*0.9;
    const cx=WP/2, cy=HP/2;
    const T=(x,y)=>[cx+(x-c0[0])*s, cy-(y-c0[1])*s];
    planView={c0,s,cx,cy};

    // 相机在图上的位置
    const C0=T(0,0);
    // 环
    xp.strokeStyle='#e6ebf2'; xp.lineWidth=1;
    for(let r=5;r<=maxR;r+=5){
      xp.beginPath(); xp.arc(C0[0],C0[1],r*s,0,7); xp.stroke();
    }
    // 十字
    xp.strokeStyle='#eef2f7';
    xp.beginPath(); xp.moveTo(C0[0],0); xp.lineTo(C0[0],HP); xp.moveTo(0,C0[1]); xp.lineTo(WP,C0[1]); xp.stroke();

    // 监控范围矩形
    if(S.zone.on){
      const z=S.zone;
      const zp=[[z.x0,z.y0],[z.x1,z.y0],[z.x1,z.y1],[z.x0,z.y1]].map(p=>T(p[0],p[1]));
      xp.beginPath(); zp.forEach((p,i)=> i?xp.lineTo(p[0],p[1]):xp.moveTo(p[0],p[1])); xp.closePath();
      xp.fillStyle='rgba(245,158,11,.12)'; xp.fill();
      xp.setLineDash([6,4]); xp.strokeStyle='rgba(217,119,6,.95)'; xp.lineWidth=1.6; xp.stroke();
      xp.setLineDash([]);
    }

    // 足迹
    if(g.valid){
      xp.beginPath();
      g.poly.forEach((p,i)=>{const q=T(p[0],p[1]); i?xp.lineTo(q[0],q[1]):xp.moveTo(q[0],q[1]);});
      xp.closePath();
      xp.fillStyle='rgba(47,111,237,.18)'; xp.fill();
      xp.strokeStyle='rgba(47,111,237,.9)'; xp.lineWidth=2; xp.stroke();
    }
    // 范围内覆盖（交集）
    if(S.zone.on){
      const inter=zoneInter(g);
      if(inter.length>2){
        xp.beginPath();
        inter.forEach((p,i)=>{const q=T(p[0],p[1]); i?xp.lineTo(q[0],q[1]):xp.moveTo(q[0],q[1]);});
        xp.closePath();
        xp.fillStyle='rgba(217,119,6,.35)'; xp.fill();
        xp.strokeStyle='rgba(180,83,9,.95)'; xp.lineWidth=1.6; xp.stroke();
      }
    }
    // 光轴
    const axisD = S.hh/Math.tan(g.th);
    if(isFinite(axisD) && axisD>0){
      const a=T(0,0), b=T(Math.cos(g.ph)*axisD, Math.sin(g.ph)*axisD);
      xp.setLineDash([5,4]); xp.strokeStyle='rgba(30,60,120,.65)';
      xp.beginPath(); xp.moveTo(a[0],a[1]); xp.lineTo(b[0],b[1]); xp.stroke(); xp.setLineDash([]);
    }
    // 相机
    xp.beginPath(); xp.arc(C0[0],C0[1],5,0,7); xp.fillStyle='#111827'; xp.fill();

    // 距离环标注（每 10 m 一个，避免拥挤）
    xp.fillStyle='#94a3b8'; xp.font='10px sans-serif'; xp.textAlign='left';
    for(let r=10;r<=maxR;r+=10){
      xp.fillText(`${r}m`, C0[0]+r*s+3, C0[1]-3);
    }
    // 标题
    xp.fillStyle='#64748b'; xp.font='12px sans-serif'; xp.textAlign='left';
    xp.fillText('平面覆盖', 10, 18);
  }

  // 平面图框选监控范围
  function planToWorld(sx,sy){
    if(!planView) return [0,0];
    const {c0,s,cx,cy}=planView;
    return [c0[0]+(sx-cx)/s, c0[1]-(sy-cy)/s];
  }
  cp.addEventListener('pointerdown',e=>{
    if(!S.zone.on) return;
    const r=cp.getBoundingClientRect();
    const w=planToWorld(e.clientX-r.left, e.clientY-r.top);
    zoneDrag={x:w[0],y:w[1]};
    cp.setPointerCapture(e.pointerId);
  });
  cp.addEventListener('pointermove',e=>{
    if(!zoneDrag) return;
    const r=cp.getBoundingClientRect();
    const w=planToWorld(e.clientX-r.left, e.clientY-r.top);
    const x0=Math.min(zoneDrag.x,w[0]), x1=Math.max(zoneDrag.x,w[0]);
    const y0=Math.min(zoneDrag.y,w[1]), y1=Math.max(zoneDrag.y,w[1]);
    if(x1-x0<0.5||y1-y0<0.5) return;
    S.zone.x0=x0; S.zone.y0=y0; S.zone.x1=x1; S.zone.y1=y1;
    syncZoneInputs();
    render();
  });
  cp.addEventListener('pointerup',()=>{ zoneDrag=null; });

  // ---------- 指标 ----------
  function metrics(){
    const g=geometry();
    $('kNear').textContent = g.near===0?'0 m':g.near.toFixed(2)+' m';
    $('kFar').textContent = isFinite(g.far)?g.far.toFixed(1)+' m':'∞';
    $('kArea').textContent = g.area?g.area.toFixed(1)+' ㎡':'—';
    const d250 = distFor(250);
    $('kId').textContent = d250===null ? '不可达' : d250.toFixed(1)+' m';

    const zi=zoneInter(g);
    const zArea=Math.max(0,(S.zone.x1-S.zone.x0)*(S.zone.y1-S.zone.y0));
    const iArea=zi.length>2?polyArea(zi):0;
    $('kZone').textContent = S.zone.on
      ? `${iArea.toFixed(1)} ㎡ · ${zArea>0?(iArea/zArea*100).toFixed(0):0}%`
      : '—';
    $('kRatio').textContent = (S.zone.on && g.area)
      ? `${(iArea/g.area*100).toFixed(0)}%`
      : '—';

    const tb=$('tbody'); tb.innerHTML='';
    for(const d of [5,10,15,20,30]){
      const p=ppf(d); const [name,cls]=level(p);
      tb.insertAdjacentHTML('beforeend',
        `<tr><td>${d} m</td><td>${p.toFixed(0)} px/m</td><td><span class="tag ${cls}">${name}</span></td></tr>`);
    }
    const warn=$('warn');
    if(!g.valid){
      warn.style.display='block';
      warn.textContent='上边缘已到或越过水平线，远端趋于无限，地面足迹不闭合。请加大俯仰角或减小垂直视场角。';
    } else if(g.far===Infinity){
      warn.style.display='block';
      warn.textContent='远端超出地平线（远边缘接近水平），实际远端受地面、围墙或像素密度限制。';
    } else warn.style.display='none';
  }

  function autoFit(){
    if(S.userZoom) return;
    const g=geometry();
    let maxR=8;
    if(g.valid) for(const p of g.poly) maxR=Math.max(maxR, Math.hypot(p[0],p[1]));
    S.view.dist=Math.min(90, Math.max(14, maxR*2.2+4));
  }
  function render(){ fit3(); fitP(); autoFit(); draw3D(); drawPlan(); metrics(); scheduleSave(); }

  // ---------- 交互 ----------
  function bindRange(id, key, fmt, dec=1){
    const r=$(id), n=$(id+'N'), v=$(id+'V');
    const apply=val=>{
      S[key]=val;
      r.value=val; n.value=val;
      if(v) v.textContent=fmt?fmt(val):val;
      render();
    };
    r.addEventListener('input',e=>apply(+e.target.value));
    n.addEventListener('change',e=>{
      let v=+e.target.value;
      v=Math.min(+n.max,Math.max(+n.min,v));
      apply(v);
    });
    apply(S[key]);
  }
  bindRange('hf','hf',v=>v.toFixed(0));
  bindRange('vf','vf',v=>v.toFixed(0));
  bindRange('hh','hh',v=>v.toFixed(1));
  bindRange('pt','pt',v=>v.toFixed(1));
  bindRange('yw','yw',v=>v.toFixed(0));
  bindRange('rl','roll',v=>v.toFixed(0));

  // 分辨率
  const pw=$('pw'), ph=$('ph'), pwN=$('pwN'), phN=$('phN');
  function syncPx(){
    S.pw=+pw.value; S.ph=+ph.value;
    pwN.value=S.pw; phN.value=S.ph;
    const px=S.pw*S.ph;
    $('resV').textContent=`${S.pw}×${S.ph} · ${(px/1e6).toFixed(2)} MP`;
    $('resPix').textContent=px.toLocaleString('en-US')+' 像素';
    render();
  }
  pw.addEventListener('input',syncPx); ph.addEventListener('input',syncPx);
  pwN.addEventListener('change',e=>{
    let v=Math.min(4096,Math.max(320,Math.round(+e.target.value)||320));
    pw.value=v; syncPx();
  });
  phN.addEventListener('change',e=>{
    let v=Math.min(2160,Math.max(240,Math.round(+e.target.value)||240));
    ph.value=v; syncPx();
  });

  // 监控范围
  function syncZoneInputs(){
    $('zx').value=+S.zone.x0.toFixed(2);
    $('zy').value=+S.zone.y0.toFixed(2);
    $('zl').value=+(S.zone.x1-S.zone.x0).toFixed(2);
    $('zw').value=+(S.zone.y1-S.zone.y0).toFixed(2);
  }
  ['zx','zy','zl','zw'].forEach(id=>$(id).addEventListener('change',()=>{
    const x0=+$('zx').value||0, y0=+$('zy').value||0;
    const L=Math.max(0.5,+$('zl').value||0.5), W=Math.max(0.5,+$('zw').value||0.5);
    S.zone.x0=x0; S.zone.y0=y0; S.zone.x1=x0+L; S.zone.y1=y0+W;
    syncZoneInputs(); render();
  }));
  $('zoneOn').addEventListener('change',e=>{ S.zone.on=e.target.checked; render(); });
  $('zoneOn').checked=S.zone.on;
  syncZoneInputs();
  pw.value=S.pw; ph.value=S.ph; syncPx();
  $('optBtn').addEventListener('click',()=>{
    if(!S.zone.on) return;
    $('optResult').textContent='计算中…';
    setTimeout(optimize,20);
  });

  // 预设
  document.querySelectorAll('.presets button').forEach(b=>{
    b.addEventListener('click',()=>{
      const set=(id,val)=>{$(id).value=val; $(id+'N').value=val;};
      set('hf',b.dataset.h); set('vf',b.dataset.v);
      pw.value=b.dataset.w; ph.value=b.dataset.hh; syncPx();
      S.hf=+b.dataset.h; S.vf=+b.dataset.v;
      $('hfV').textContent=S.hf; $('vfV').textContent=S.vf;
      render();
    });
  });

  // 恢复默认
  $('resetBtn').addEventListener('click',()=>{
    document.cookie='camview=; max-age=0; path=/';
    try{ localStorage.removeItem('camview'); }catch(e){}
    location.reload();
  });

  // 3D 拖动/平移/缩放
  let drag=null;
  c3d.addEventListener('contextmenu',e=>e.preventDefault());
  c3d.addEventListener('pointerdown',e=>{
    drag={x:e.clientX,y:e.clientY,pan:(e.button===2||e.button===1||e.shiftKey)};
    c3d.setPointerCapture(e.pointerId);
  });
  c3d.addEventListener('pointermove',e=>{
    if(!drag) return;
    const dx=e.clientX-drag.x, dy=e.clientY-drag.y;
    drag={...drag,x:e.clientX,y:e.clientY};
    if(drag.pan){
      const {fwd,right}=cameraBasis();
      let fg=[fwd[0],fwd[1],0];
      if(Math.hypot(fg[0],fg[1])<1e-6) fg=[0,1,0]; else fg=norm(fg);
      const k=2*S.view.dist*Math.tan(45*D2R/2)/H3;
      S.view.tx=(S.view.tx||0)+(-right[0]*dx+fg[0]*dy)*k;
      S.view.ty=(S.view.ty||0)+(-right[1]*dx+fg[1]*dy)*k;
    } else {
      S.view.az-=dx*0.008;
      S.view.el=Math.max(0.08,Math.min(Math.PI/2,S.view.el+dy*0.006));
    }
    draw3D();
  });
  c3d.addEventListener('pointerup',()=>drag=null);
  c3d.addEventListener('wheel',e=>{
    e.preventDefault();
    S.userZoom=true;
    S.view.dist=Math.max(6,Math.min(90,S.view.dist*(1+Math.sign(e.deltaY)*0.08)));
    draw3D();
  },{passive:false});

  window.addEventListener('resize',render);
  render();
})();
