'use strict';
/* Campus 3D HVCB: location stays in each visitor's browser. */
(async function init(){
  const $=id=>document.getElementById(id);
  const note=s=>{$('notice').textContent=s};
  const request=async file=>{const r=await fetch(file,{cache:'no-store'});if(!r.ok)throw Error(`Không đọc được ${file} (HTTP ${r.status})`);return r.json()};
  let config,sites,routes,footprints;
  try{
    [config,sites,routes,footprints]=await Promise.all([
      request('data/config.json'),request('data/sites.json'),request('data/routes.json'),request('data/buildings.geojson')
    ]);
  }catch(e){note('Không mở được dữ liệu: '+e.message+'\nHãy chạy Colab và đăng toàn bộ thư mục lên GitHub Pages.');return;}
  sites=sites.sites||[]; routes=routes.routes||{};
  const rawFeatures=footprints.features||[];
  const byId=new Map(rawFeatures.map(f=>[String(f.properties?.id||''),f]));
  const center=config.center||[106.7019,10.8124];
  const norm=s=>String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/đ/g,'d').toLowerCase().trim();
  const radians=x=>x*Math.PI/180;
  const metres=(a,b)=>{const R=6371000,lat=radians(b[0]-a[0]),lon=radians(b[1]-a[1]),u=Math.sin(lat/2)**2+Math.cos(radians(a[0]))*Math.cos(radians(b[0]))*Math.sin(lon/2)**2;return R*2*Math.asin(Math.min(1,Math.sqrt(u)))};
  const pathLen=path=>path.slice(1).reduce((t,p,i)=>t+metres(path[i],p),0);
  const findByQuery=q=>{const n=norm(q);return sites.find(s=>norm(s.name)===n||s.aliases?.some(a=>norm(a)===n))||sites.find(s=>norm(s.name).includes(n))};
  const getRoute=(gate,id)=>routes?.[gate]?.[id]||[];
  let selected='',user=null,accuracy=null,gpsId=null,assignMode=false,mode='',map=null,googleMap=null,googleOverlay=null;
  let gmRoute=null,gmPin=null,gmGps=null,gmAccuracy=null,mlGps=null,mlDest=null,previousPosition=null;
  const storageKey='HVCB_BUILDING_ASSIGNMENTS_2026_V1';
  let assignments={};
  rawFeatures.forEach(f=>{if(f.properties?.site_id)assignments[String(f.properties.id)]=f.properties.site_id});
  try{const saved=JSON.parse(localStorage.getItem(storageKey)||'null');if(saved && typeof saved==='object'&&!Array.isArray(saved))assignments={...assignments,...saved}}catch(e){}
  const persist=()=>{try{localStorage.setItem(storageKey,JSON.stringify(assignments))}catch(e){console.warn('Storage unavailable',e)}};
  const geoWithLabels=()=>({type:'FeatureCollection',features:rawFeatures.map(f=>({...f,properties:{...f.properties,site_id:assignments[String(f.properties?.id)]||''}}))});
  function buildingCenter(name){
    const matched=rawFeatures.filter(f=>assignments[String(f.properties?.id)]===name);
    if(!matched.length)return null;
    // Calculated as mean coordinates of the exterior rings, enough to focus the camera.
    const coords=[];matched.forEach(f=>{const poly=f.geometry.type==='Polygon'?[f.geometry.coordinates]:f.geometry.coordinates;poly.forEach(p=>{if(p[0])coords.push(...p[0])})});
    if(!coords.length)return null;
    return [coords.reduce((sum,p)=>sum+p[0],0)/coords.length,coords.reduce((sum,p)=>sum+p[1],0)/coords.length];
  }
  function projectToRoute(p,path){
    if(path.length<2)return null;
    const xfactor=111320*Math.cos(radians(p[0])),yfactor=110540;
    let best=null;
    for(let i=0;i<path.length-1;i++){
      const a=path[i],b=path[i+1],ax=(a[1]-p[1])*xfactor,ay=(a[0]-p[0])*yfactor,bx=(b[1]-p[1])*xfactor,by=(b[0]-p[0])*yfactor;
      const vx=bx-ax,vy=by-ay,t=Math.max(0,Math.min(1,-(ax*vx+ay*vy)/Math.max(.0001,vx*vx+vy*vy)));
      const d=Math.hypot(ax+t*vx,ay+t*vy);
      if(!best||d<best.d)best={d,i,point:[a[0]+t*(b[0]-a[0]),a[1]+t*(b[1]-a[1])]};
    }
    return best;
  }
  function choosePath(){
    if(!selected)return {path:[],note:''};
    const setting=$('gate').value;
    const candidates=(setting==='auto'?['1','2']:[setting]).map(g=>({g,path:getRoute(g,selected)})).filter(x=>x.path.length>1);
    if(!candidates.length)return {path:[],note:'Chưa có tuyến nội bộ số hóa.'};
    if(user){
      const results=candidates.map(c=>({...c,snap:projectToRoute(user,c.path)})).sort((a,b)=>a.snap.d-b.snap.d);
      if(accuracy!=null && accuracy<=35 && results[0].snap.d<=25){
        const nearest=results[0];const path=[nearest.snap.point,...nearest.path.slice(nearest.snap.i+1)];
        return {path,note:`GPS gần tuyến Cổng ${nearest.g}; đoạn còn lại trên tuyến số hóa khoảng ${Math.round(pathLen(path))} m (lệch tuyến ~${Math.round(nearest.snap.d)} m).`};
      }
      const nearest=results[0];
      return {path:nearest.path,note:`GPS lệch đường hoặc chưa đủ chính xác (±${Math.round(accuracy||0)} m, gần nhất cách tuyến ~${Math.round(nearest.snap.d)} m). Chỉ hiển thị tuyến Cổng ${nearest.g}, KHÔNG vẽ đường thẳng xuyên tòa nhà.`};
    }
    const preferred=candidates[0];
    return {path:preferred.path,note:`Tuyến tham khảo từ Cổng ${preferred.g}: ${Math.round(pathLen(preferred.path))} m. Bật GPS trên điện thoại để theo dõi.`};
  }
  const routeGeo=points=>({type:'FeatureCollection',features:points.length>1?[{type:'Feature',properties:{},geometry:{type:'LineString',coordinates:points.map(p=>[p[1],p[0]])}}]:[]});
  function refreshBuildingLayers(){
    if(mode==='maplibre'&&map?.getSource('campus-buildings')){
      map.getSource('campus-buildings').setData(geoWithLabels());
      map.setFilter('hvcb-highlight',['==',['get','site_id'],selected||'__no_selection__']);
    }
    if(mode==='google'&&googleOverlay){googleOverlay.setProps({layers:[makeDeckLayer()]})}
  }
  function makeDeckLayer(){
    return new deck.GeoJsonLayer({id:'hvcb-3d-buildings',data:geoWithLabels(),extruded:true,filled:true,stroked:false,pickable:true,
      getElevation:f=>Math.max(3,Number(f.properties?.height_m)||12),
      getFillColor:f=>f.properties?.site_id&&f.properties.site_id===selected?[255,188,25,245]:[66,126,162,205],
      onClick:info=>{if(info.object)handleBuildingClick(info.object.properties)}
    });
  }
  function handleBuildingClick(properties){
    const bid=String(properties.id||'');if(!bid)return;
    if(assignMode){
      if(!selected){note('Hãy chọn tên Tòa A / B / C, Hội trường A hoặc KTX trước.');return;}
      assignments[bid]=assignments[bid]===selected?'':selected;
      persist();refreshBuildingLayers();draw();
      note(`${assignments[bid]?'Đã gán':'Đã bỏ gán'} khối ${bid} ${assignments[bid]?'cho '+sites.find(s=>s.id===selected)?.name:''}. Những tên này chưa được xác minh ngoài thực địa.`);
      return;
    }
    const s=assignments[bid];if(s)choose(s,true);else note('Khối này chưa có tên. Mở “Gán tên khối nhà” để đặt tên bằng cách chạm vào mô hình 3D.');
  }
  function draw(){
    refreshBuildingLayers();
    const site=sites.find(s=>s.id===selected);
    $('openGoogle').disabled=!site;$('focus').disabled=!site;
    if(!site){note(`${rawFeatures.length} khối 3D đã tải. Tìm Tòa C để làm nổi bật. Nếu sáng sai khối, dùng “Gán tên khối nhà”.`);return;}
    const {path,note:routeNote}=choosePath();
    const labeled=rawFeatures.filter(f=>assignments[String(f.properties?.id)]===selected).length;
    const quality=labeled?`Đã tô sáng ${labeled} khối. Nếu vị trí chưa đúng, hãy gán tên lại bằng cách chạm vào khối thật.`:'Chưa có khối 3D nào gắn tên này. Đang dùng điểm cuối tuyến để xác định đích; hãy gán tên khối để làm sáng đúng tòa.';
    note(`${site.name}: ${quality}\n${routeNote}`);
    if(mode==='maplibre'&&map){
      const source=map.getSource('campus-route');if(source)source.setData(routeGeo(path));
      if(!mlDest)mlDest=new maplibregl.Marker({color:'#ef9b21'});
      mlDest.setLngLat([site.lng,site.lat]).addTo(map);
    }else if(mode==='google'&&googleMap){
      gmRoute.setPath(path.map(p=>({lat:p[0],lng:p[1]})));
      gmPin.setPosition({lat:site.lat,lng:site.lng});gmPin.setVisible(true);
    }
  }
  function focusDestination(){
    const site=sites.find(s=>s.id===selected);if(!site)return;
    const xy=buildingCenter(selected)||[site.lng,site.lat];
    if(mode==='maplibre'&&map)map.flyTo({center:xy,zoom:18.5,pitch:60,bearing:-22,duration:700});
    if(mode==='google'&&googleMap){googleMap.panTo({lat:xy[1],lng:xy[0]});googleMap.setZoom(19);googleMap.setTilt(55)}
  }
  function choose(id,focus=true){
    const site=sites.find(s=>s.id===id);if(!site)return;
    selected=id;$('destination').value=id;$('search').value=site.name;
    draw();if(focus)focusDestination();
  }
  for(const s of sites){
    const option=document.createElement('option');option.value=s.id;option.textContent=s.name;$('destination').appendChild(option);
    const op=document.createElement('option');op.value=s.name;$('names').appendChild(op);
  }
  $('destination').onchange=()=>choose($('destination').value);
  $('search').addEventListener('input',()=>{const q=$('search').value;if(norm(q).length<2)return;const found=findByQuery(q);if(found)choose(found.id,false)});
  $('search').onkeydown=e=>{if(e.key==='Enter'){const found=findByQuery($('search').value);if(found)choose(found.id,true)}};
  $('gate').onchange=draw;
  $('focus').onclick=focusDestination;
  $('assignMode').onclick=()=>{assignMode=!assignMode;$('assignMode').textContent=assignMode?'Đang gán tên — nhấn để tắt':'Bật chế độ gán khối';note(assignMode?'Chọn tòa trong ô tìm kiếm rồi NHẤN VÀO KHỐI 3D tương ứng. Chạm lại khối đó để bỏ gán.':'Đã tắt chế độ gán.');};
  $('saveLabels').onclick=()=>{
    const a=document.createElement('a'),blob=new Blob([JSON.stringify(assignments,null,2)],{type:'application/json'});
    a.href=URL.createObjectURL(blob);a.download='hvcb_building_labels.json';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);
  };
  $('openGoogle').onclick=()=>{
    const s=sites.find(x=>x.id===selected);if(!s)return;
    const params=new URLSearchParams({api:'1',destination:`${s.lat},${s.lng}`,travelmode:'walking'});
    if(user)params.set('origin',user.join(','));
    window.open('https://www.google.com/maps/dir/?'+params.toString(),'_blank','noopener,noreferrer');
  };
  $('startGps').onclick=()=>{
    if(!navigator.geolocation){$('gpsInfo').textContent='Trình duyệt không hỗ trợ định vị.';return}
    if(!window.isSecureContext){$('gpsInfo').textContent='GPS cần HTTPS; mở từ GitHub Pages, không mở file HTML trực tiếp.';return}
    if(gpsId!==null)return;
    $('gpsInfo').textContent='Đang xin quyền GPS…';
    gpsId=navigator.geolocation.watchPosition(p=>{
      user=[p.coords.latitude,p.coords.longitude];accuracy=p.coords.accuracy;
      $('gpsInfo').textContent=`GPS trực tiếp: ${user[0].toFixed(6)}, ${user[1].toFixed(6)} • sai số ±${Math.round(accuracy)} m`;
      if(mode==='maplibre'&&map){
        if(!mlGps)mlGps=new maplibregl.Marker({color:'#1472ee'});
        mlGps.setLngLat([user[1],user[0]]).addTo(map);
        const src=map.getSource('gps-accuracy');if(src)src.setData({type:'Feature',geometry:{type:'Point',coordinates:[user[1],user[0]]},properties:{}});
      }
      if(mode==='google'&&googleMap){gmGps.setCenter({lat:user[0],lng:user[1]});gmGps.setRadius(Math.max(3,accuracy));gmGps.setVisible(true)}
      if(!previousPosition){
        if(mode==='maplibre'&&map)map.easeTo({center:[user[1],user[0]],duration:700});
        if(mode==='google'&&googleMap)googleMap.panTo({lat:user[0],lng:user[1]});
      }
      previousPosition=[...user];if(selected)draw();
    },e=>{
      $('gpsInfo').textContent='Không lấy được GPS: '+e.message;
      if(e.code===1 && gpsId!==null){navigator.geolocation.clearWatch(gpsId);gpsId=null}
    },{enableHighAccuracy:true,maximumAge:1500,timeout:20000});
  };
  $('stopGps').onclick=()=>{
    if(gpsId!==null){navigator.geolocation.clearWatch(gpsId);gpsId=null}
    user=null;accuracy=null;previousPosition=null;
    if(mlGps)mlGps.remove();if(gmGps)gmGps.setVisible(false);
    $('gpsInfo').textContent='Đã dừng GPS.';if(selected)draw();
  };
  async function libMap(){
    mode='maplibre';
    map=new maplibregl.Map({container:'map',style:'https://tiles.openfreemap.org/styles/liberty',center,zoom:17.5,pitch:56,bearing:-22,antialias:true});
    map.addControl(new maplibregl.NavigationControl({visualizePitch:true}),'top-right');
    await new Promise((resolve,reject)=>{map.once('load',resolve);map.once('error',e=>{if(!map.isStyleLoaded())reject(e.error||Error('Nền bản đồ lỗi'))})});
    map.addSource('campus-buildings',{type:'geojson',data:geoWithLabels()});
    map.addLayer({id:'hvcb-buildings',source:'campus-buildings',type:'fill-extrusion',paint:{'fill-extrusion-color':'#4b80a1','fill-extrusion-height':['get','height_m'],'fill-extrusion-opacity':.83}});
    map.addLayer({id:'hvcb-highlight',source:'campus-buildings',type:'fill-extrusion',filter:['==',['get','site_id'],'__no_selection__'],paint:{'fill-extrusion-color':'#ffc332','fill-extrusion-height':['+',['get','height_m'],2],'fill-extrusion-opacity':1}});
    map.addSource('campus-route',{type:'geojson',data:routeGeo([])});
    map.addLayer({id:'campus-route',type:'line',source:'campus-route',paint:{'line-color':'#f06b2a','line-width':5},layout:{'line-cap':'round','line-join':'round'}});
    map.on('click',e=>{const hits=map.queryRenderedFeatures(e.point,{layers:['hvcb-highlight','hvcb-buildings']});if(hits.length)handleBuildingClick(hits[0].properties)});
    map.addSource('gps-accuracy',{type:'geojson',data:{type:'FeatureCollection',features:[]}});
    // GPS error radius is shown textually; real-time marker is shown above.
  }
  async function loadScript(url){return new Promise((ok,no)=>{const s=document.createElement('script');s.src=url;s.async=true;s.onload=ok;s.onerror=()=>no(Error('Không tải được JavaScript từ CDN'));document.head.appendChild(s)})}
  async function makeGoogleMap(){
    await loadScript('https://unpkg.com/deck.gl@9.1.0/dist.min.js');
    await loadScript('https://maps.googleapis.com/maps/api/js?v=weekly&loading=async&key='+encodeURIComponent(config.googleMapsApiKey));
    if(!window.google?.maps||!window.deck?.GoogleMapsOverlay)throw Error('Google Maps / deck.gl chưa sẵn sàng');
    await google.maps.importLibrary('maps');mode='google';
    googleMap=new google.maps.Map($('map'),{center:{lat:center[1],lng:center[0]},zoom:18.2,tilt:55,heading:22,mapId:config.googleMapId||'DEMO_MAP_ID',mapTypeControl:false,streetViewControl:false});
    googleOverlay=new deck.GoogleMapsOverlay({layers:[makeDeckLayer()]});googleOverlay.setMap(googleMap);
    gmRoute=new google.maps.Polyline({map:googleMap,strokeColor:'#ec6c29',strokeWeight:6,strokeOpacity:.96});
    gmPin=new google.maps.Marker({map:googleMap,visible:false,title:'Điểm cuối tuyến nội bộ'});
    gmGps=new google.maps.Circle({map:googleMap,visible:false,radius:8,strokeColor:'#1769ed',strokeWeight:2,fillColor:'#1769ed',fillOpacity:.18});
  }
  try{
    if(config.googleMapsApiKey?.trim())await makeGoogleMap();else await libMap();
    note(rawFeatures.length?`Đã dựng ${rawFeatures.length} khối 3D. Tìm Tòa A/B/C, Hội trường A hoặc KTX. Nếu khối tô sáng sai, nhấn “Gán tên khối nhà”.`:'Chưa tải được footprint công trình từ OSM; cần chạy lại Colab khi có kết nối dữ liệu.');
  }catch(e){
    console.error(e);
    if(mode==='google'){
      try{googleOverlay?.setMap(null);googleOverlay=null;googleMap=null;$('map').innerHTML='';await libMap();note('Google Maps không tải được, đã chuyển sang bản đồ miễn phí: '+e.message)}
      catch(second){note('Cả hai bản đồ chưa mở được: '+second.message)}
    }else note('Không mở được bản đồ: '+e.message);
  }
})();
