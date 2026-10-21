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


  // Stable building keys are generated from source footprint coordinates in app.js.
  const storageKey = 'hvcb-building-links-v1';
  let links = {};
  try { links = JSON.parse(localStorage.getItem(storageKey) || '{}'); } catch (_) {}
  if (!links || typeof links !== 'object' || Array.isArray(links)) links = {};
  let activeMaterials = [];
  let picking = false;
  const assign = document.createElement('button');
  assign.type = 'button';
  assign.textContent = 'Gắn tòa nhà';
  assign.title = 'Chọn điểm đến, rồi bấm vào khối nhà tương ứng';
  const save = document.createElement('button');
  save.type = 'button';
  save.textContent = 'Xuất gắn tòa nhà';
  root.querySelector('.hvcb-buttons').append(assign, save);

  function clearBuildingHighlight() {
    ctx.beforeHighlight?.();
    for (const {mesh, original, clones} of activeMaterials) {
      mesh.material = original;
      delete mesh.userData.hvcbDestinationActive;
      clones.forEach(m => m.dispose());
    }
    activeMaterials = [];
  }

  function highlightDestination() {
    const key = links[dest.value];
    if (!key) return;
    ctx.beforeHighlight?.();
    ctx.getBuildingGroup?.()?.traverse(mesh => {
      if (!mesh.isMesh || mesh.userData.hvcbBuildingKey !== key) return;
      const original = mesh.material;
      const clones = (Array.isArray(original) ? original : [original]).map(m => {
        const c = m.clone();
        // Keep deliberately invisible caps invisible.
        if (!(c.transparent && c.opacity === 0)) {
          c.color?.setHex(0xffc247);
          c.emissive?.setHex(0xffa000);
          if (c.emissive) c.emissiveIntensity = 0.85;
        }
        return c;
      });
      mesh.material = Array.isArray(original) ? clones : clones[0];
      mesh.userData.hvcbDestinationActive = true;
      activeMaterials.push({mesh, original, clones});
    });
  }

  function stopPicking() {
    picking = false;
    assign.textContent = 'Gắn tòa nhà';
    if (ctx.canvas) ctx.canvas.style.cursor = '';
  }
  assign.addEventListener('click', () => {
    if (picking) { stopPicking(); renderRoute(false); return; }
    picking = true;
    assign.textContent = 'Hủy gắn';
    if (ctx.canvas) ctx.canvas.style.cursor = 'crosshair';
    status.textContent = 'Bấm vào khối nhà của ' + routes.destinations[dest.value] + ' (Esc để hủy).';
  });
  window.addEventListener('keydown', e => {
    if (e.key === 'Escape' && picking) { stopPicking(); renderRoute(false); }
  });
  ctx.canvas?.addEventListener('click', e => {
    if (!picking) return;
    e.stopPropagation();
    const rect = ctx.canvas.getBoundingClientRect();
    const pointer = new THREE.Vector2(
      (e.clientX - rect.left) / rect.width * 2 - 1,
      -(e.clientY - rect.top) / rect.height * 2 + 1
    );
    const ray = new THREE.Raycaster();
    ray.setFromCamera(pointer, camera);
    const buildings = ctx.getBuildingGroup?.();
    if (!buildings) return;
    const hit = ray.intersectObject(buildings, true).find(h => h.object.userData.hvcbBuildingKey);
    if (!hit) { status.textContent = 'Chưa chọn trúng tòa nhà. Bà bấm vào mái hoặc mặt tòa nhà nhé.'; return; }
    links[dest.value] = hit.object.userData.hvcbBuildingKey;
    let stored = true;
    try { localStorage.setItem(storageKey, JSON.stringify(links)); } catch (_) { stored = false; }
    stopPicking();
    show = true;
    hide.textContent = 'Ẩn tuyến';
    renderRoute(false);
    status.append(document.createTextNode(stored
      ? ' · Đã nhớ tòa nhà trên trình duyệt này.'
      : ' · Chưa lưu được trên trình duyệt; hãy xuất gắn tòa nhà.'));
  }, true);
  save.addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(links, null, 2)], {type: 'application/json'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'campus_highlights.json'; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  // Optional published mapping makes the same destination glow for every visitor.
  fetch('./campus_highlights.json', {cache: 'no-cache'})
    .then(r => r.ok ? r.json() : null)
    .then(shared => {
      if (!shared || typeof shared !== 'object' || Array.isArray(shared)) return;
      links = {...shared, ...links};
      renderRoute(false);
    }).catch(() => {});

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
    highlightDestination();
    traveler.visible = true;
    traveler.position.copy(current[0]);
    const mins = total / (routes.speed_m_per_min || 75);
    status.innerHTML = `<strong>Cổng ${gate.value} → ${routes.destinations[dest.value]}</strong><br>${total.toFixed(0)} m · khoảng ${mins.toFixed(1)} phút đi bộ`;
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
  gate.addEventListener('change', () => { stopPicking(); renderRoute(true); });
  dest.addEventListener('change', () => { stopPicking(); renderRoute(true); });
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
