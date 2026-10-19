/* Card boundaries and perspective correction. Runs locally; no image upload. */
window.TcgCardVision = (() => {
    let readyPromise, cv;
    const distance = (a,b) => Math.hypot(a.x-b.x,a.y-b.y);
    async function ready() {
        if (cv?.Mat) return true;
        if (!readyPromise) readyPromise = new Promise((resolve,reject) => {
            let timer, tick, settled = false, watching;
            const finish = (error,value) => {
                if (settled) return; settled = true; clearTimeout(timer); clearInterval(tick);
                // Some OpenCV builds expose an Emscripten thenable that resolves to itself.
                // Keep the module in this closure; resolving it would loop indefinitely.
                if (error) reject(error); else {cv=value; resolve(true);}
            };
            const inspect = () => {
                const candidate = window.cv;
                if (candidate?.Mat) finish(null,candidate);
                else if (candidate && typeof candidate.then === 'function' && candidate!==watching) {
                    watching=candidate;
                    candidate.then(value => {if (value?.Mat) finish(null,value);}, error => finish(error));
                }
            };
            timer = setTimeout(() => finish(new Error('โหลดระบบจับขอบไม่สำเร็จ ใช้ปุ่มถ่ายตามกรอบได้')),45000);
            tick = setInterval(inspect,250);
            if (!document.getElementById('tcg-opencv-script')) {
                const script = document.createElement('script'); script.id = 'tcg-opencv-script';
                script.src = 'https://docs.opencv.org/4.13.0/opencv.js'; script.async = true;
                script.onload = inspect;
                script.onerror = () => {script.remove(); finish(new Error('โหลดระบบจับขอบไม่ได้ ใช้ปุ่มถ่ายตามกรอบได้'));};
                document.head.appendChild(script);
            }
            inspect();
        }).catch(error => {readyPromise=null; throw error;});
        return readyPromise;
    }
    function order(points) {
        const center = points.reduce((c,p) => ({x:c.x+p.x/4,y:c.y+p.y/4}),{x:0,y:0});
        const sorted = [...points].sort((a,b) => Math.atan2(a.y-center.y,a.x-center.x)-Math.atan2(b.y-center.y,b.x-center.x));
        const first = sorted.reduce((best,p,i) => p.x+p.y < sorted[best].x+sorted[best].y ? i : best,0);
        return sorted.slice(first).concat(sorted.slice(0,first)); // TL TR BR BL, upright cards.
    }
    function area(points) {
        return Math.abs(points.reduce((sum,p,i) => {const q=points[(i+1)%4];return sum+p.x*q.y-q.x*p.y;},0))/2;
    }
    function detect(canvas) {
        if (!cv?.Mat || !canvas.width || !canvas.height) return null;
        const owned = [], keep = mat => {owned.push(mat); return mat;};
        try {
            const src=keep(cv.imread(canvas)), gray=keep(new cv.Mat()), blur=keep(new cv.Mat()), edges=keep(new cv.Mat());
            cv.cvtColor(src,gray,cv.COLOR_RGBA2GRAY);
            cv.GaussianBlur(gray,blur,new cv.Size(5,5),0);
            cv.Canny(blur,edges,40,120);
            const kernel=keep(cv.Mat.ones(3,3,cv.CV_8U)); cv.dilate(edges,edges,kernel);
            const contours=keep(new cv.MatVector()), hierarchy=keep(new cv.Mat());
            cv.findContours(edges,contours,hierarchy,cv.RETR_LIST,cv.CHAIN_APPROX_SIMPLE);
            let best=null;
            for(let i=0;i<contours.size();i++) {
                const contour=contours.get(i), approx=new cv.Mat();
                try {
                    const fraction=Math.abs(cv.contourArea(contour))/(canvas.width*canvas.height);
                    if(fraction<.17 || fraction>.91) continue;
                    cv.approxPolyDP(contour,approx,.025*cv.arcLength(contour,true),true);
                    if(approx.rows!==4 || !cv.isContourConvex(approx)) continue;
                    const points=order(Array.from({length:4},(_,j)=>({x:approx.data32S[j*2]/canvas.width,y:approx.data32S[j*2+1]/canvas.height})));
                    if(points.some(p=>p.x<.018||p.x>.982||p.y<.018||p.y>.982)) continue;
                    const px=points.map(p=>({x:p.x*canvas.width,y:p.y*canvas.height}));
                    const width=(distance(px[0],px[1])+distance(px[2],px[3]))/2;
                    const height=(distance(px[0],px[3])+distance(px[1],px[2]))/2;
                    const ratio=width/height;
                    if(ratio<.54 || ratio>.88) continue;
                    const center=points.reduce((s,p)=>({x:s.x+p.x/4,y:s.y+p.y/4}),{x:0,y:0});
                    if(Math.abs(center.x-.5)>.19 || Math.abs(center.y-.5)>.19) continue;
                    // Reject extreme perspective and interior art windows. Favor large centered cards.
                    if(Math.max(distance(px[0],px[1]),distance(px[2],px[3]))/Math.min(distance(px[0],px[1]),distance(px[2],px[3]))>1.7) continue;
                    const score=fraction*2-Math.abs(ratio-63/88)*.7-Math.hypot(center.x-.5,center.y-.5);
                    if(!best || score>best.score) best={points,score,fraction};
                } finally {approx.delete(); contour.delete();}
            }
            return best;
        } finally {owned.reverse().forEach(mat=>mat.delete());}
    }
    function warp(canvas,points) {
        if (!cv?.Mat) throw new Error('ระบบจับขอบยังไม่พร้อม');
        const center=points.reduce((s,p)=>({x:s.x+p.x/4,y:s.y+p.y/4}),{x:0,y:0});
        // Small margin retains the physical border and rounded corners.
        const p=points.map(q=>({x:Math.max(0,Math.min(1,center.x+(q.x-center.x)*1.025))*canvas.width,
            y:Math.max(0,Math.min(1,center.y+(q.y-center.y)*1.025))*canvas.height}));
        const h=Math.max(distance(p[0],p[3]),distance(p[1],p[2]));
        const height=Math.max(1,Math.min(2000,Math.round(h))), width=Math.round(height*63/88);
        const owned=[],keep=m=>{owned.push(m);return m;};
        try {
            const src=keep(cv.imread(canvas)),dst=keep(new cv.Mat());
            const from=keep(cv.matFromArray(4,1,cv.CV_32FC2,p.flatMap(q=>[q.x,q.y])));
            const to=keep(cv.matFromArray(4,1,cv.CV_32FC2,[0,0,width-1,0,width-1,height-1,0,height-1]));
            const transform=keep(cv.getPerspectiveTransform(from,to));
            cv.warpPerspective(src,dst,transform,new cv.Size(width,height),cv.INTER_LINEAR,cv.BORDER_REPLICATE);
            const output=document.createElement('canvas');cv.imshow(output,dst);return output;
        } finally {owned.reverse().forEach(mat=>mat.delete());}
    }
    function signature(canvas) {
        const small=document.createElement('canvas');small.width=32;small.height=44;
        small.getContext('2d').drawImage(canvas,0,0,32,44);
        const pixels=small.getContext('2d').getImageData(0,0,32,44).data;
        return Array.from({length:32*44},(_,i)=>(pixels[i*4]+pixels[i*4+1]+pixels[i*4+2])/3);
    }
    function createGate(holdMs=1200) {
        let anchor=null,previous=null,started=0,latched=false;
        return {
            reset(){anchor=null;previous=null;started=0;latched=false;},
            latch(){latched=true;},
            update(points,pixels,now) {
                if(latched) return {progress:1,ready:false,latched:true};
                if(!points){anchor=null;previous=null;started=0;return {progress:0,ready:false};}
                const motion=previous&&pixels ? pixels.reduce((sum,v,i)=>sum+Math.abs(v-previous[i]),0)/pixels.length : 0;
                const drift=anchor ? Math.max(...points.map((p,i)=>distance(p,anchor[i]))) : Infinity;
                if(drift>.018 || motion>7){anchor=points.map(p=>({...p}));started=now;}
                previous=pixels;
                const progress=Math.min(1,(now-started)/holdMs);
                if(progress===1) latched=true;
                return {progress,ready:progress===1,latched};
            }
        };
    }
    return {ready,detect,warp,signature,createGate,order,area};
})();
