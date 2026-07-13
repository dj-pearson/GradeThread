import { useEffect, useRef } from "react";
import * as THREE from "three";
import { orbFocus } from "./scroll-experience/orb-bus";

/**
 * HeroOrb — a self-contained WebGL "condition orb" that sits BEHIND the hero
 * copy as ambient motion. Default-exported so it can be `React.lazy()`-loaded
 * into its own chunk: `three` (~150KB) never touches the eager landing graph.
 *
 * It is deliberately gated by <HeroBackdrop> (desktop + motion-OK only), so this
 * component assumes it is allowed to run. It still self-guards on WebGL support
 * and cleans up everything on unmount (rAF, GL context, geometry, material,
 * listeners) — important because the landing route mounts/unmounts on SPA nav.
 *
 * No EffectComposer / postprocessing: the glow is done in-shader (fresnel rim +
 * translucent shell with NormalBlending) so it reads on both light and dark
 * backgrounds and stays cheap.
 */

// Brand palette (linear-ish sRGB → 0..1) — navy #0F3460, red #E94560, night #1A1A2E
const NAVY = new THREE.Color("#0F3460");
const RED = new THREE.Color("#E94560");
const NIGHT = new THREE.Color("#1A1A2E");

const vertexShader = /* glsl */ `
  uniform float uTime;
  varying vec3 vNormal;
  varying vec3 vView;
  varying float vNoise;

  // Ashima simplex noise (3D)
  vec3 mod289(vec3 x){ return x - floor(x * (1.0/289.0)) * 289.0; }
  vec4 mod289(vec4 x){ return x - floor(x * (1.0/289.0)) * 289.0; }
  vec4 permute(vec4 x){ return mod289(((x*34.0)+1.0)*x); }
  vec4 taylorInvSqrt(vec4 r){ return 1.79284291400159 - 0.85373472095314 * r; }
  float snoise(vec3 v){
    const vec2 C = vec2(1.0/6.0, 1.0/3.0);
    const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
    vec3 i  = floor(v + dot(v, C.yyy));
    vec3 x0 = v - i + dot(i, C.xxx);
    vec3 g = step(x0.yzx, x0.xyz);
    vec3 l = 1.0 - g;
    vec3 i1 = min(g.xyz, l.zxy);
    vec3 i2 = max(g.xyz, l.zxy);
    vec3 x1 = x0 - i1 + C.xxx;
    vec3 x2 = x0 - i2 + C.yyy;
    vec3 x3 = x0 - D.yyy;
    i = mod289(i);
    vec4 p = permute(permute(permute(
      i.z + vec4(0.0, i1.z, i2.z, 1.0))
      + i.y + vec4(0.0, i1.y, i2.y, 1.0))
      + i.x + vec4(0.0, i1.x, i2.x, 1.0));
    float n_ = 0.142857142857;
    vec3 ns = n_ * D.wyz - D.xzx;
    vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
    vec4 x_ = floor(j * ns.z);
    vec4 y_ = floor(j - 7.0 * x_);
    vec4 x = x_ * ns.x + ns.yyyy;
    vec4 y = y_ * ns.x + ns.yyyy;
    vec4 h = 1.0 - abs(x) - abs(y);
    vec4 b0 = vec4(x.xy, y.xy);
    vec4 b1 = vec4(x.zw, y.zw);
    vec4 s0 = floor(b0) * 2.0 + 1.0;
    vec4 s1 = floor(b1) * 2.0 + 1.0;
    vec4 sh = -step(h, vec4(0.0));
    vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
    vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
    vec3 p0 = vec3(a0.xy, h.x);
    vec3 p1 = vec3(a0.zw, h.y);
    vec3 p2 = vec3(a1.xy, h.z);
    vec3 p3 = vec3(a1.zw, h.w);
    vec4 norm = taylorInvSqrt(vec4(dot(p0,p0), dot(p1,p1), dot(p2,p2), dot(p3,p3)));
    p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
    vec4 m = max(0.6 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
    m = m * m;
    return 42.0 * dot(m*m, vec4(dot(p0,x0), dot(p1,x1), dot(p2,x2), dot(p3,x3)));
  }

  void main(){
    float t = uTime * 0.18;
    float n = snoise(position * 1.3 + vec3(t, -t * 0.7, t * 0.4));
    n += 0.5 * snoise(position * 2.6 + vec3(-t, t * 0.5, t));
    vNoise = n;

    vec3 displaced = position + normal * n * 0.22;

    vec4 mvPosition = modelViewMatrix * vec4(displaced, 1.0);
    vNormal = normalize(normalMatrix * normal);
    vView = normalize(-mvPosition.xyz);
    gl_Position = projectionMatrix * mvPosition;
  }
`;

const fragmentShader = /* glsl */ `
  precision highp float;
  uniform vec3 uNavy;
  uniform vec3 uRed;
  uniform vec3 uNight;
  uniform float uTime;
  uniform float uScroll;
  varying vec3 vNormal;
  varying vec3 vView;
  varying float vNoise;

  void main(){
    // Fresnel rim — bright at glancing angles, faint head-on.
    float fres = pow(1.0 - clamp(dot(normalize(vNormal), normalize(vView)), 0.0, 1.0), 2.4);

    // Noise + slow time sweep drives the navy↔red gradient across the shell;
    // scrolling biases the whole shell hotter (toward red) as the orb descends.
    float mixT = clamp(0.5 + 0.5 * sin(vNoise * 2.0 + uTime * 0.3) + uScroll * 0.35, 0.0, 1.0);
    vec3 shell = mix(uNavy, uRed, mixT);

    // Deep core fades to night so the centre stays translucent, rim glows.
    vec3 color = mix(uNight, shell, fres);
    color += uRed * fres * (0.35 + uScroll * 0.5); // red bloom on the rim, hotter as you scroll

    float alpha = 0.32 + fres * 0.68;
    gl_FragColor = vec4(color, alpha);
  }
`;

export default function HeroOrb() {
  const mountRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    // Probe WebGL — bail quietly to the static glow fallback if unavailable.
    const probe = document.createElement("canvas");
    const hasWebGL = !!(
      probe.getContext("webgl2") || probe.getContext("webgl")
    );
    if (!hasWebGL) return;

    const width = mount.clientWidth || window.innerWidth;
    const height = mount.clientHeight || window.innerHeight;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 100);
    // Pulled back so the whole orb — including its bright fresnel rim — sits
    // inside the mask on a full-viewport canvas (US-1955); closer than this and
    // the glowing rim lands in the masked-off edges and the orb reads as faint.
    camera.position.z = 4.7;

    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      powerPreference: "low-power",
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    renderer.setSize(width, height);
    renderer.setClearColor(0x000000, 0);
    mount.appendChild(renderer.domElement);

    const geometry = new THREE.IcosahedronGeometry(1.55, 24);
    const material = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      transparent: true,
      depthWrite: false,
      uniforms: {
        uTime: { value: 0 },
        uScroll: { value: 0 },
        uNavy: { value: NAVY.clone() },
        uRed: { value: RED.clone() },
        uNight: { value: NIGHT.clone() },
      },
    });
    const mesh = new THREE.Mesh(geometry, material);
    scene.add(mesh);

    // Captured once — `uniforms` is a string-indexed record, so under
    // noUncheckedIndexedAccess each lookup is `IUniform | undefined`.
    const uTime = material.uniforms.uTime!;
    const uScroll = material.uniforms.uScroll!;

    // Smoothed pointer parallax (cheap).
    const pointer = { x: 0, y: 0, tx: 0, ty: 0 };
    const onPointerMove = (e: PointerEvent) => {
      pointer.tx = (e.clientX / window.innerWidth - 0.5) * 0.6;
      pointer.ty = (e.clientY / window.innerHeight - 0.5) * 0.6;
    };
    window.addEventListener("pointermove", onPointerMove, { passive: true });

    // US-1955: the orb is the page's spine. It reads normalized page-scroll
    // progress (0..1) each frame and travels/shrinks/heats as you descend, so
    // it flows out of the hero and down the page instead of dying at 100vh.
    // Cache the scroll range (reading scrollHeight per-frame forces reflow).
    let maxScroll = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
    const scroll = { v: 0 };
    // Reused each frame to project the halo target's screen position into world
    // space (no per-frame allocation).
    const focusVec = new THREE.Vector3();

    const onResize = () => {
      const w = mount.clientWidth || window.innerWidth;
      const h = mount.clientHeight || window.innerHeight;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
      maxScroll = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
    };
    window.addEventListener("resize", onResize);

    // Pause the loop when the tab is hidden — no wasted GPU/battery.
    let visible = !document.hidden;
    const onVisibility = () => {
      visible = !document.hidden;
      if (visible) loop();
    };
    document.addEventListener("visibilitychange", onVisibility);

    const clock = new THREE.Clock();
    let raf = 0;
    const loop = () => {
      if (!visible) return;
      raf = requestAnimationFrame(loop);
      const t = clock.getElapsedTime();
      uTime.value = t;

      pointer.x += (pointer.tx - pointer.x) * 0.05;
      pointer.y += (pointer.ty - pointer.y) * 0.05;

      // Smoothly track page-scroll progress (0..1) and let it choreograph the
      // orb: drift right + up, shrink, and dim as it leaves the hero, then hand
      // off to the certificate scene in a later phase. eased toward the target
      // so momentum scroll stays buttery.
      const target = Math.min(Math.max(window.scrollY / maxScroll, 0), 1);
      scroll.v += (target - scroll.v) * 0.08;
      const p = scroll.v;

      // Default (scroll-driven) targets: drift right, shrink, dim, heat.
      let tx = p * 1.75;
      let ty = p * 0.5;
      let ts = 1 - p * 0.5;
      let th = p;
      let to = 1 - p * 0.55;

      // US-1957 halo: when the certificate scene is active, converge on the
      // grade ring (read its live screen rect → world space) so the orb forms a
      // halo around the 9.0, then release (strength ramps 0→1→0) and resume the
      // downward travel.
      const focus = orbFocus;
      if (focus.active && focus.targetEl && focus.strength > 0.001) {
        const r = focus.targetEl.getBoundingClientRect();
        if (r.width > 0) {
          const ndcX = ((r.left + r.width / 2) / window.innerWidth) * 2 - 1;
          const ndcY = -(((r.top + r.height / 2) / window.innerHeight) * 2 - 1);
          focusVec.set(ndcX, ndcY, 0.5).unproject(camera).sub(camera.position);
          const dist = -camera.position.z / focusVec.z;
          const wx = camera.position.x + focusVec.x * dist;
          const wy = camera.position.y + focusVec.y * dist;
          const s = focus.strength;
          tx += (wx - tx) * s;
          ty += (wy - ty) * s;
          ts += (focus.scale - ts) * s;
          th = Math.max(th, focus.heat * s);
          to += (0.98 - to) * s;
        }
      }

      uScroll.value = th;

      // Ease the mesh toward the targets so both scroll travel and halo docking
      // stay buttery.
      mesh.position.x += (tx - mesh.position.x) * 0.12;
      mesh.position.y += (ty - mesh.position.y) * 0.12;
      const curScale = mesh.scale.x;
      mesh.scale.setScalar(curScale + (ts - curScale) * 0.12);
      mount.style.opacity = String(to);

      mesh.rotation.y = t * 0.12 + pointer.x + p * 0.8;
      mesh.rotation.x = pointer.y * 0.6;
      renderer.render(scene, camera);
    };
    loop();

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("resize", onResize);
      document.removeEventListener("visibilitychange", onVisibility);
      geometry.dispose();
      material.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      if (renderer.domElement.parentNode === mount) {
        mount.removeChild(renderer.domElement);
      }
    };
  }, []);

  return (
    <div
      ref={mountRef}
      aria-hidden="true"
      style={{ opacity: 1 }}
      className="pointer-events-none fixed inset-0 -z-[8] [mask-image:radial-gradient(64%_62%_at_50%_40%,black,transparent_80%)]"
    />
  );
}
