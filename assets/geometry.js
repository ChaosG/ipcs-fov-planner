/* 公共几何与投影：planner.js 与 app.js 共用。无依赖，仅暴露 window.Geo。 */
(() => {
  const D2R = Math.PI/180, R2D = 180/Math.PI;

  const sub=(a,b)=>[a[0]-b[0],a[1]-b[1],a[2]-b[2]];
  const dot=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
  const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
  const norm=a=>{const l=Math.hypot(...a)||1;return [a[0]/l,a[1]/l,a[2]/l];};

  // 相机姿态基：光轴 axis、屏幕右 right、屏幕上 up；tH/tV 为半视场角正切
  function basis(cam){
    const th=(+cam.pitch||0)*D2R, ph=(+cam.yaw||0)*D2R, rl=(+cam.roll||0)*D2R;
    const tH=Math.tan((+cam.hf||0)/2*D2R), tV=Math.tan((+cam.vf||0)/2*D2R);
    const axis=[Math.cos(th)*Math.cos(ph), Math.cos(th)*Math.sin(ph), -Math.sin(th)];
    const r0=[-Math.sin(ph), Math.cos(ph), 0];
    const u0=[Math.sin(th)*Math.cos(ph), Math.sin(th)*Math.sin(ph), Math.cos(th)];
    const cr=Math.cos(rl), sr=Math.sin(rl);
    const right=[r0[0]*cr+u0[0]*sr, r0[1]*cr+u0[1]*sr, r0[2]*cr+u0[2]*sr];
    const up=[-r0[0]*sr+u0[0]*cr, -r0[1]*sr+u0[1]*cr, -r0[2]*sr+u0[2]*cr];
    return {axis,right,up,tH,tV,th,ph,rl};
  }

  // 四条视界棱的方向向量，顺序 (-,-),(+,-),(+,+),(-,+)
  function rays(cam){
    const {axis,right,up,tH,tV}=basis(cam);
    const out=[];
    for(const v of [-1,1]) for(const u of [-1,1]){
      out.push([axis[0]+u*tH*right[0]+v*tV*up[0],
                axis[1]+u*tH*right[1]+v*tV*up[1],
                axis[2]+u*tH*right[2]+v*tV*up[2]]);
    }
    return out;
  }

  // 世界坐标地面足迹；任一条棱不下地面（d.z >= eps）返回 null
  function footprint(cam,eps=-1e-9){
    const h=+cam.h||0, x=+cam.x||0, y=+cam.y||0;
    if(h<=0) return null;
    const {axis,right,up,tH,tV}=basis(cam);
    const pts=[];
    for(const v of [-1,1]) for(const u of [-1,1]){
      const d=[axis[0]+u*tH*right[0]+v*tV*up[0],
               axis[1]+u*tH*right[1]+v*tV*up[1],
               axis[2]+u*tH*right[2]+v*tV*up[2]];
      if(d[2]>=eps) return null;
      const t=h/(-d[2]);
      pts.push([x+d[0]*t, y+d[1]*t]);
    }
    return [pts[0],pts[1],pts[3],pts[2]];
  }

  function insideConvex(poly,p){
    let sign=0;
    for(let i=0;i<poly.length;i++){
      const a=poly[i], b=poly[(i+1)%poly.length];
      const cr=(b[0]-a[0])*(p[1]-a[1])-(b[1]-a[1])*(p[0]-a[0]);
      if(Math.abs(cr)<1e-9) continue;
      const s=cr>0?1:-1;
      if(sign===0) sign=s; else if(s!==sign) return false;
    }
    return true;
  }

  function clipPoly(poly,rect){
    const [x0,y0,x1,y1]=rect;
    const clip=(pts,ins,it)=>{
      const out=[];
      for(let i=0;i<pts.length;i++){
        const a=pts[i], b=pts[(i+1)%pts.length];
        const ia=ins(a), ib=ins(b);
        if(ia) out.push(a);
        if(ia!==ib) out.push(it(a,b));
      }
      return out;
    };
    let p=poly;
    p=clip(p,q=>q[0]>=x0,(a,b)=>[x0,a[1]+(x0-a[0])/(b[0]-a[0])*(b[1]-a[1])]);
    p=clip(p,q=>q[0]<=x1,(a,b)=>[x1,a[1]+(x1-a[0])/(b[0]-a[0])*(b[1]-a[1])]);
    p=clip(p,q=>q[1]>=y0,(a,b)=>[a[0]+(y0-a[1])/(b[1]-a[1])*(b[0]-a[0]),y0]);
    p=clip(p,q=>q[1]<=y1,(a,b)=>[a[0]+(y1-a[1])/(b[1]-a[1])*(b[0]-a[0]),y1]);
    return p;
  }

  function polyArea(p){
    let a=0;
    for(let i=0;i<p.length;i++){const q=p[(i+1)%p.length]; a+=p[i][0]*q[1]-q[0]*p[i][1];}
    return Math.abs(a)/2;
  }

  // 像素密度 px/m；dist 为地面距离
  const ppf=(pw,hf,h,dist)=>pw/(2*Math.hypot(dist,h)*Math.tan(hf/2*D2R));

  // 透视投影；withDepth 为 true 时返回 [x,y,z]
  function makeProjector(o){
    const {w,h,target,az,el,dist,nearZ=0.2,fovY=45,withDepth=false}=o;
    const eye=[target[0]+dist*Math.cos(el)*Math.cos(az),
               target[1]+dist*Math.cos(el)*Math.sin(az),
               target[2]+dist*Math.sin(el)];
    const fwd=norm(sub(target,eye));
    let right=cross(fwd,[0,0,1]);
    if(Math.hypot(right[0],right[1],right[2])<1e-6) right=[1,0,0];
    right=norm(right);
    const up=cross(right,fwd);
    const f=0.5*h/Math.tan(fovY*D2R/2);
    return p=>{
      const v=sub(p,eye), z=dot(v,fwd);
      if(z<nearZ) return null;
      const out=[w/2+f*dot(v,right)/z, h/2-f*dot(v,up)/z];
      if(withDepth) out.push(z);
      return out;
    };
  }

  window.Geo={D2R,R2D,vec:{sub,dot,cross,norm},basis,rays,footprint,insideConvex,clipPoly,polyArea,ppf,makeProjector};
})();
