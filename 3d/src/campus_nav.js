/* Campus Navigation HVCB extension for 3D OSM Model.
 * Coordinate system: EPSG:32648, same as the downloaded QGIS OSM layers.
 * Version 1: surveyed/manual waypoint chains, not auto-shortest-path routing.
 * Keeps existing viewer, data and attributions intact.
 */
export async function createCampusNavigation(ctx) {
  const { THREE, CSS2DObject, scene, camera, controls, metersToLocal,
    terrainLocalYAt, terrainLayerHeight, isReady } = ctx;
  const root = document.getElementById('hvcb-navigation');
  const gate = document.getElementById('hvcb-gate');
  const dest = document.getElementById('hvcb-destination');
  const status = document.getElementById('hvcb-route-info');
  const find = document.getElementById('hvcb-route-find');
  const focus = document.getElementById('hvcb-route-focus');
  const hide = document.getElementById('hvcb-route-hide');
  const header = document.getElementById('hvcb-route-collapse');
  if (!root || !gate || !dest || !status) return null;

  let routes;
  try {
    const response = await fetch('./campus_routes.json', { cache: 'no-cache' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    routes = await response.json();
    if (routes.crs !== 'EPSG:32648') throw new Error('Unsupported CRS for 3D scene');
  } catch (e) {
    status.textContent = 'Không tải được dữ liệu tuyến: ' + e.message;
    return null;
  }

  for (const [id, label] of Object.entries(routes.destinations)) {
    const option = document.createElement('option');
    option.value = id;
    option.textContent = label;
    dest.appendChild(option);
  }
  const params = new URLSearchParams(location.search);
  if (params.get('gate') === '2') gate.value = '2';
  if (Object.hasOwn(routes.destinations, params.get('to'))) dest.value = params.get('to');

  const group = new THREE.Group();
  group.name = 'HVCB_Campus_Navigation_3D';
  scene.add(group);
  const sphereGeo = new THREE.SphereGeometry(2.7, 16, 12);
  const currentMaterial = new THREE.MeshBasicMaterial({ color: 0xfde047, depthTest: false });
  const traveler = new THREE.Mesh(sphereGeo, currentMaterial);
  traveler.renderOrder = 2001;
  traveler.visible = false;
  group.add(traveler);
  let current = [];
  let lengths = [];
  let total = 0;
  let progress = 0;
  let show = true;
  let waitingMessage = 'Đang đợi mô hình 3D tải xong…';


  // Automatic destination highlight: use the footprint nearest the route endpoint.
  // The endpoint must be at the intended building entrance.
  let highlighted = [];
  function clearBuildingHighlight() {
    ctx.beforeHighlight?.();
    for (const item of highlighted) {
      item.mesh.material = item.original;
      delete item.mesh.userData.hvcbDestinationActive;
      item.clones.forEach(m => m.dispose());
    }
    highlighted = [];
  }

  function segmentDistance2(p, a, b) {
    const dx = b.x-a.x, dz = b.z-a.z;
    const length2 = dx*dx+dz*dz;
    const t = length2 ? Math.max(0, Math.min(1,
      ((p.x-a.x)*dx+(p.z-a.z)*dz)/length2)) : 0;
    return (p.x-a.x-t*dx)**2 + (p.z-a.z-t*dz)**2;
  }
  function triangleDistance2(p, a, b, c) {
    const cross = (u,v,w) => (v.x-u.x)*(w.z-u.z)-(v.z-u.z)*(w.x-u.x);
    const area = cross(a,b,c);
    if (Math.abs(area) > 1e-8) {
      const x = cross(a,b,p), y = cross(b,c,p), z = cross(c,a,p);
      if ((x>=0 && y>=0 && z>=0) || (x<=0 && y<=0 && z<=0)) return 0;
    }
    return Math.min(segmentDistance2(p,a,b), segmentDistance2(p,b,c), segmentDistance2(p,c,a));
  }
  function footprintDistance2(mesh, point) {
    const positions = mesh.geometry?.attributes?.position;
    if (!positions) return Infinity;
    const index = mesh.geometry.index;
    const count = index ? index.count : positions.count;
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
    let best = Infinity;
    for (let i=0; i+2<count; i+=3) {
      a.fromBufferAttribute(positions,index ? index.getX(i) : i).applyMatrix4(mesh.matrixWorld);
      b.fromBufferAttribute(positions,index ? index.getX(i+1) : i+1).applyMatrix4(mesh.matrixWorld);
      c.fromBufferAttribute(positions,index ? index.getX(i+2) : i+2).applyMatrix4(mesh.matrixWorld);
      best = Math.min(best, triangleDistance2(point,a,b,c));
      if (best === 0) break;
    }
    return best;
  }
  function highlightDestination(point) {
    const buildings = ctx.getBuildingGroup?.();
    if (!buildings) return false;
    buildings.updateWorldMatrix(true, true);
    let nearestKey = null, best = Infinity;
    buildings.traverse(mesh => {
      if (!mesh.isMesh || !mesh.visible || !mesh.userData.hvcbBuildingKey) return;
      const d = footprintDistance2(mesh, point);
      if (d < best) { best = d; nearestKey = mesh.userData.hvcbBuildingKey; }
    });
    // Verified campus dormitory footprints in mybuildings.geojson.
    // The residential complex has three separate OSM building features.
    const dormitoryIds = new Set(['1214273258', '1214273259', '1214273260']);
    const isDormitory = dest.value === 'ky-tuc-xa';
    if (!isDormitory && (!nearestKey || best > 35*35)) return false;
    ctx.beforeHighlight?.();
    buildings.traverse(mesh => {
      if (!mesh.isMesh) return;
      const selected = isDormitory
        ? dormitoryIds.has(String(mesh.userData.osm_id))
        : mesh.userData.hvcbBuildingKey === nearestKey;
      if (!selected) return;
      const original = mesh.material;
      const clones = (Array.isArray(original) ? original : [original]).map(m => {
        const clone = m.clone();
        if (!(clone.transparent && clone.opacity === 0)) {
          clone.color?.setHex(0xffc247);
          clone.emissive?.setHex(0xffa000);
          if (clone.emissive) clone.emissiveIntensity = 0.85;
        }
        return clone;
      });
      mesh.material = Array.isArray(original) ? clones : clones[0];
      mesh.userData.hvcbDestinationActive = true;
      highlighted.push({mesh, original, clones});
    });
    return highlighted.length > 0;
  }

  function clearRoute() {
    clearBuildingHighlight();
    for (const obj of [...group.children]) {
      if (obj === traveler) continue;
      group.remove(obj);
      obj.traverse((child) => {
        if (child.geometry) child.geometry.dispose();
        if (child.material) {
          const materials = Array.isArray(child.material) ? child.material : [child.material];
          materials.forEach(m => m.dispose());
        }
        if (child.element) child.element.remove();
      });
    }
    current = [];
    lengths = [];
    total = 0;
    progress = 0;
    traveler.visible = false;
  }

  function worldPoint(pair) {
    const [x, z] = metersToLocal(pair[0], pair[1]);
    // A small elevation separates lines from the viewer's road/sidewalk layers.
    const y = terrainLocalYAt(x, z) + (terrainLayerHeight || 1.36) + 1.35;
    return new THREE.Vector3(x, y, z);
  }

  function makeDot(point, color, radius) {
    const material = new THREE.MeshBasicMaterial({ color, depthTest: false });
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 14, 10), material);
    mesh.position.copy(point);
    mesh.renderOrder = 2002;
    group.add(mesh);
    return mesh;
  }

  function makeLabel(point, text, variant) {
    const element = document.createElement('div');
    element.className = 'hvcb-scene-label ' + variant;
    element.textContent = text;
    const label = new CSS2DObject(element);
    label.position.copy(point).add(new THREE.Vector3(0, 8, 0));
    group.add(label);
  }

  function renderRoute(shouldFocus = false) {
    clearRoute();
    if (!show) return;
    if (!isReady()) {
      status.textContent = waitingMessage;
      return;
    }
    const points = routes.routes[gate.value]?.[dest.value];
    if (!Array.isArray(points) || points.length < 2) {
      status.textContent = 'Chưa có dữ liệu cho tuyến này.';
      return;
    }
    current = points.map(worldPoint);
    for (let i = 1; i < current.length; i++) {
      const a = current[i - 1], b = current[i];
      const d = a.distanceTo(b);
      lengths.push(d);
      total += d;
      const segmentCurve = new THREE.LineCurve3(a, b);
      const geometry = new THREE.TubeGeometry(segmentCurve, Math.max(2, Math.ceil(d / 2)), 0.95, 6, false);
      const material = new THREE.MeshBasicMaterial({ color: 0x1d8dfa, depthTest: false, transparent: true, opacity: 0.97 });
      const pathPart = new THREE.Mesh(geometry, material);
      pathPart.renderOrder = 2000;
      group.add(pathPart);
    }
    makeDot(current[0], 0x16a34a, 3.3);
    makeDot(current[current.length - 1], 0xdc2626, 3.3);
    for (let i = 1; i < current.length - 1; i++) makeDot(current[i], 0xfacc15, 1.4);
    makeLabel(current[0], `CỔNG SỐ ${gate.value}`, 'hvcb-label-start');
    makeLabel(current[current.length - 1], routes.destinations[dest.value].toUpperCase(), 'hvcb-label-end');
    const buildingLit = highlightDestination(current[current.length - 1]);
    traveler.visible = true;
    traveler.position.copy(current[0]);
    const mins = total / (routes.speed_m_per_min || 75);
    status.innerHTML = `<strong>Cổng ${gate.value} → ${routes.destinations[dest.value]}</strong><br>${total.toFixed(0)} m · khoảng ${mins.toFixed(1)} phút đi bộ`;
    if (!buildingLit) status.append(document.createTextNode(' · Chưa xác định được tòa nhà gần điểm đến.'));
    if (shouldFocus) focusRoute();
  }

  function focusRoute() {
    if (current.length < 2) return;
    const minX = Math.min(...current.map(p => p.x));
    const maxX = Math.max(...current.map(p => p.x));
    const minZ = Math.min(...current.map(p => p.z));
    const maxZ = Math.max(...current.map(p => p.z));
    const x = (minX + maxX) / 2, z = (minZ + maxZ) / 2;
    const size = Math.max(maxX - minX, maxZ - minZ, 65);
    const dist = Math.max(100, size * 1.5);
    const target = new THREE.Vector3(x, current[0].y, z);
    // Avoid changing controls during Walk mode; user can return to orbit mode first.
    if (controls?.enabled === false) {
      status.textContent = 'Hãy thoát chế độ đi bộ (Esc) trước khi chuyển góc nhìn.';
      return;
    }
    controls.target.copy(target);
    camera.position.set(x + dist * 0.55, target.y + dist * 0.93, z + dist * 0.83);
    camera.lookAt(target);
    camera.updateProjectionMatrix();
    controls.update();
  }

  function tick(delta) {
    if (!show || current.length < 2 || !traveler.visible || total < 1) return;
    // Visual animation ~12 m/s; NOT the speed used to estimate walking time.
    progress = (progress + Math.min(Math.max(delta, 0), 0.2) * 12) % total;
    let remaining = progress;
    for (let i = 0; i < lengths.length; i++) {
      if (remaining <= lengths[i] || i === lengths.length - 1) {
        traveler.position.lerpVectors(current[i], current[i + 1], Math.min(1, remaining / Math.max(0.001, lengths[i])));
        break;
      }
      remaining -= lengths[i];
    }
  }

  function redraw() { renderRoute(false); }
  gate.addEventListener('change', () => renderRoute(true));
  dest.addEventListener('change', () => { show = true; hide.textContent = 'Ẩn tuyến'; renderRoute(true); });
  find.addEventListener('click', () => renderRoute(true));
  focus.addEventListener('click', focusRoute);
  hide.addEventListener('click', () => {
    show = !show;
    hide.textContent = show ? 'Ẩn tuyến' : 'Hiện tuyến';
    renderRoute(false);
    if (!show) status.textContent = 'Đã ẩn tuyến đường.';
  });
  header.addEventListener('click', () => root.classList.toggle('is-collapsed'));
  renderRoute(false);
  return { redraw, tick, renderRoute };
}
