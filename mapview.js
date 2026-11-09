/*
 * MapView — карта на MapLibre з двома режимами:
 *   'classic' — звичайна карта OSM, північ угорі;
 *   'neon'    — темна неонова 3D-карта (OpenFreeMap), нахил і поворот за напрямком руху.
 * Координати в API — [lat, lon], як у решті навігатора.
 */
(function (root) {
  'use strict';
  const OFM = 'https://tiles.openfreemap.org';
  const FONT = ['Noto Sans Regular'];
  const ll = p => [p[1], p[0]];
  const NAME = ['coalesce', ['get', 'name:uk'], ['get', 'name']];

  function classicStyle() {
    return {
      version: 8, glyphs: OFM + '/fonts/{fontstack}/{range}.pbf',
      sources: { osm: { type: 'raster', tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'], tileSize: 256, maxzoom: 19, attribution: '© OpenStreetMap' } },
      layers: [{ id: 'osm', type: 'raster', source: 'osm' }]
    };
  }

  function neonStyle() {
    const road = (id, classes, color, w, blur, opacity, minzoom) => ({
      id, type: 'line', source: 'omt', 'source-layer': 'transportation', minzoom: minzoom || 0,
      filter: ['in', ['get', 'class'], ['literal', classes]],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': color, 'line-opacity': opacity, 'line-blur': blur,
        'line-width': ['interpolate', ['exponential', 1.6], ['zoom'], 10, w * 0.25, 14, w, 18, w * 4]
      }
    });
    const MAJOR = ['motorway', 'trunk', 'primary'];
    const MID = ['secondary', 'tertiary'];
    const MINOR = ['minor', 'service'];
    return {
      version: 8, glyphs: OFM + '/fonts/{fontstack}/{range}.pbf',
      sources: { omt: { type: 'vector', url: OFM + '/planet', attribution: '© OpenMapTiles © OpenStreetMap' } },
      layers: [
        { id: 'bg', type: 'background', paint: { 'background-color': '#07020f' } },
        { id: 'park', type: 'fill', source: 'omt', 'source-layer': 'landuse', filter: ['in', ['get', 'class'], ['literal', ['park', 'cemetery', 'grass']]], paint: { 'fill-color': '#0b1a14', 'fill-opacity': 0.6 } },
        { id: 'wood', type: 'fill', source: 'omt', 'source-layer': 'landcover', filter: ['in', ['get', 'class'], ['literal', ['wood', 'grass']]], paint: { 'fill-color': '#0a1712', 'fill-opacity': 0.6 } },
        { id: 'water', type: 'fill', source: 'omt', 'source-layer': 'water', paint: { 'fill-color': '#0c0838' } },
        { id: 'waterway', type: 'line', source: 'omt', 'source-layer': 'waterway', paint: { 'line-color': '#1d1470', 'line-width': 1.5 } },
        // світіння доріг: широкий розмитий шар + тонка яскрава серцевина
        road('minor-glow', MINOR, '#6a1fb0', 5, 4, 0.35, 13),
        road('minor', MINOR, '#a24dff', 1.2, 0, 0.8, 13),
        road('mid-glow', MID, '#c21fb8', 8, 5, 0.45),
        road('mid', MID, '#ff5ce6', 1.8, 0, 0.95),
        road('major-glow', MAJOR, '#ff1fb4', 12, 7, 0.55),
        road('major', MAJOR, '#ff8af0', 2.6, 0, 1),
        {
          id: 'bridge-rail', type: 'line', source: 'omt', 'source-layer': 'transportation',
          filter: ['==', ['get', 'class'], 'rail'], minzoom: 12,
          paint: { 'line-color': '#3a2a6a', 'line-width': 1, 'line-dasharray': [3, 3] }
        },
        {
          id: 'building-3d', type: 'fill-extrusion', source: 'omt', 'source-layer': 'building', minzoom: 14,
          paint: {
            'fill-extrusion-color': '#160a2e',
            'fill-extrusion-height': ['coalesce', ['get', 'render_height'], 8],
            'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0],
            'fill-extrusion-opacity': 0.75
          }
        },
        {
          id: 'road-names', type: 'symbol', source: 'omt', 'source-layer': 'transportation_name', minzoom: 14,
          layout: { 'symbol-placement': 'line', 'text-field': NAME, 'text-font': FONT, 'text-size': 12 },
          paint: { 'text-color': '#e7c8ff', 'text-halo-color': '#07020f', 'text-halo-width': 1.5 }
        },
        {
          id: 'places', type: 'symbol', source: 'omt', 'source-layer': 'place',
          filter: ['in', ['get', 'class'], ['literal', ['city', 'town', 'suburb', 'quarter', 'neighbourhood']]],
          layout: { 'text-field': NAME, 'text-font': FONT, 'text-size': ['match', ['get', 'class'], 'city', 16, 13], 'text-transform': 'uppercase', 'text-letter-spacing': 0.1 },
          paint: { 'text-color': '#7fe7ff', 'text-halo-color': '#07020f', 'text-halo-width': 2 }
        }
      ]
    };
  }

  // Коло радіусом r метрів як полігон (для кола похибки)
  function circle(p, r) {
    const pts = [], k = 111320 * Math.cos(p[0] * Math.PI / 180);
    for (let i = 0; i <= 40; i++) {
      const a = i / 40 * 2 * Math.PI;
      pts.push([p[1] + r * Math.cos(a) / k, p[0] + r * Math.sin(a) / 110540]);
    }
    return { type: 'Feature', geometry: { type: 'Polygon', coordinates: [pts] } };
  }
  const fc = feats => ({ type: 'FeatureCollection', features: feats });
  const lineF = pts => ({ type: 'Feature', geometry: { type: 'LineString', coordinates: pts.map(ll) } });
  const pointF = p => ({ type: 'Feature', geometry: { type: 'Point', coordinates: ll(p) } });

  function el(cls, html) {
    const e = document.createElement('div');
    e.className = cls; if (html != null) e.innerHTML = html;
    return e;
  }

  const ARROW = '<svg viewBox="0 0 40 40" width="40" height="40"><path d="M20 3 L34 35 L20 27 L6 35 Z" fill="#ffffff" stroke="#00e5ff" stroke-width="2.5" stroke-linejoin="round"/></svg>';

  const MV = {
    map: null, theme: 'classic', ready: false,
    data: { route: [], signals: [], acc: null },
    markers: { pos: null, start: null, dest: null, pois: [], pins: [] },
    posKind: 'gps', bearing: 0, handlers: {},

    supported() {
      try {
        const c = document.createElement('canvas');
        return !!(window.WebGLRenderingContext && (c.getContext('webgl') || c.getContext('experimental-webgl')));
      } catch (e) { return false; }
    },

    init(container, theme, center) {
      this.theme = theme;
      this.map = new maplibregl.Map({
        container, style: theme === 'neon' ? neonStyle() : classicStyle(),
        center: ll(center), zoom: 12, pitch: 0, bearing: 0,
        attributionControl: { compact: true }, maxPitch: 70, dragRotate: false, pitchWithRotate: false
      });
      this.map.touchZoomRotate.disableRotation();
      this.map.on('style.load', () => { this.ready = true; this._addLayers(); });
      const userMove = e => { if (e.originalEvent && this.handlers.userMove) this.handlers.userMove(); };
      this.map.on('dragstart', userMove);
      this.map.on('zoomstart', userMove);
      this.map.on('click', e => this.handlers.click && this.handlers.click([e.lngLat.lat, e.lngLat.lng]));
      this._longPress();
      document.body.classList.toggle('neon', theme === 'neon');
    },

    on(name, fn) { this.handlers[name] = fn; },

    // Довге натискання (≈0,6 с) — для міток
    _longPress() {
      let t = null, start = null;
      const cancel = () => { clearTimeout(t); t = null; };
      this.map.on('touchstart', e => {
        if (e.originalEvent.touches.length !== 1) return cancel();
        start = e.point; const lng = e.lngLat;
        t = setTimeout(() => { t = null; this.handlers.longPress && this.handlers.longPress([lng.lat, lng.lng]); }, 600);
      });
      this.map.on('touchmove', e => { if (t && start && (Math.abs(e.point.x - start.x) > 10 || Math.abs(e.point.y - start.y) > 10)) cancel(); });
      this.map.on('touchend', cancel);
      this.map.on('contextmenu', e => this.handlers.longPress && this.handlers.longPress([e.lngLat.lat, e.lngLat.lng]));
    },

    setTheme(theme) {
      if (theme === this.theme) return;
      this.theme = theme; this.ready = false;
      document.body.classList.toggle('neon', theme === 'neon');
      this.map.setStyle(theme === 'neon' ? neonStyle() : classicStyle(), { diff: false });
      if (theme === 'classic') this.map.easeTo({ pitch: 0, bearing: 0, duration: 600 });
    },

    _addLayers() {
      const m = this.map, neon = this.theme === 'neon';
      m.addSource('acc', { type: 'geojson', data: this.data.acc || fc([]) });
      m.addSource('route', { type: 'geojson', data: this.data.route.length ? lineF(this.data.route) : fc([]) });
      m.addSource('signals', { type: 'geojson', data: fc(this.data.signals.map(pointF)) });
      m.addLayer({ id: 'acc-fill', type: 'fill', source: 'acc', paint: { 'fill-color': neon ? '#00e5ff' : '#1f7ae0', 'fill-opacity': 0.12 } });
      if (neon) {
        m.addLayer({ id: 'route-glow', type: 'line', source: 'route', layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': '#00e5ff', 'line-width': 22, 'line-blur': 14, 'line-opacity': 0.55 } });
        m.addLayer({ id: 'route-line', type: 'line', source: 'route', layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': '#9ff6ff', 'line-width': 6 } });
      } else {
        m.addLayer({ id: 'route-line', type: 'line', source: 'route', layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': '#1f7ae0', 'line-width': 6, 'line-opacity': 0.85 } });
      }
      m.addLayer({ id: 'signals', type: 'circle', source: 'signals',
        paint: { 'circle-radius': neon ? 5 : 4, 'circle-color': '#ff2d55', 'circle-stroke-color': '#fff', 'circle-stroke-width': 1, 'circle-blur': neon ? 0.3 : 0 } });
    },

    _set(id, data) { const s = this.ready && this.map.getSource(id); if (s) s.setData(data); },

    setRoute(pts) { this.data.route = pts || []; this._set('route', pts && pts.length ? lineF(pts) : fc([])); },
    setSignals(pts) { this.data.signals = pts || []; this._set('signals', fc(this.data.signals.map(pointF))); },

    drawPos(p, r, kind, bearing) {
      this.data.acc = circle(p, r); this._set('acc', this.data.acc);
      if (!this.markers.pos) {
        const e = el('mv-pos');
        this.markers.pos = new maplibregl.Marker({ element: e, rotationAlignment: 'map', pitchAlignment: 'map' }).setLngLat(ll(p)).addTo(this.map);
      }
      const e = this.markers.pos.getElement();
      const arrow = bearing != null;
      const want = (arrow ? 'arrow' : 'dot') + kind;
      if (e.dataset.k !== want) {
        e.dataset.k = want;
        e.innerHTML = arrow ? ARROW : '<div class="mv-dot"></div>';
        e.classList.toggle('dr', kind !== 'gps');
      }
      this.markers.pos.setLngLat(ll(p)).setRotation(arrow ? bearing : 0);
    },

    marker(key, p, html, cls) {
      if (this.markers[key]) { this.markers[key].remove(); this.markers[key] = null; }
      if (!p) return;
      this.markers[key] = new maplibregl.Marker({ element: el('mv-pin ' + (cls || ''), html), anchor: 'bottom' }).setLngLat(ll(p)).addTo(this.map);
    },

    setPois(list, onTap) {
      this.markers.pois.forEach(m => m.remove()); this.markers.pois = [];
      for (const poi of list || []) {
        const e = el('mv-poi', '<span>' + poi.icon + '</span>');
        e.title = poi.name;
        if (onTap) e.addEventListener('click', ev => { ev.stopPropagation(); onTap(poi); });
        this.markers.pois.push(new maplibregl.Marker({ element: e }).setLngLat(ll([poi.lat, poi.lon])).addTo(this.map));
      }
    },

    setPins(list, onTap) {
      this.markers.pins.forEach(m => m.remove()); this.markers.pins = [];
      for (const pin of list || []) {
        const e = el('mv-pin pin', '📌<b>' + pin.name.replace(/[<>&]/g, '') + '</b>');
        e.addEventListener('click', ev => { ev.stopPropagation(); onTap && onTap(pin); });
        this.markers.pins.push(new maplibregl.Marker({ element: e, anchor: 'bottom' }).setLngLat(ll([pin.lat, pin.lon])).addTo(this.map));
      }
    },

    setView(p, z) { this.map.jumpTo({ center: ll(p), zoom: z }); },

    fit(pts, padding) {
      if (!pts || !pts.length) return;
      let a = [180, 90], b = [-180, -90];
      for (const p of pts) { a = [Math.min(a[0], p[1]), Math.min(a[1], p[0])]; b = [Math.max(b[0], p[1]), Math.max(b[1], p[0])]; }
      this.map.fitBounds([a, b], { padding: padding || 40, bearing: 0, pitch: 0, duration: 0 });
    },

    // Камера навігації: у неоні — нахил 60° і поворот за курсом, машина внизу екрана
    follow(p, bearing, pad) {
      const neon = this.theme === 'neon';
      this.map.easeTo({
        center: ll(p), zoom: neon ? 17 : 16.5,
        bearing: neon && bearing != null ? bearing : 0,
        pitch: neon ? 60 : 0,
        padding: pad || { top: 0, bottom: 0, left: 0, right: 0 },
        duration: 900, easing: t => t, essential: true
      });
    },

    idle(pad) {
      const neon = this.theme === 'neon';
      this.map.easeTo({ pitch: neon ? 45 : 0, bearing: 0, padding: pad || { top: 0, bottom: 0, left: 0, right: 0 }, duration: 600 });
    }
  };

  root.MapView = MV;
})(window);
