import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import type { CoreState, EnvironmentId, UiLang } from '../types/ui';
import { I18N } from '../lib/i18n';
import {
  useExecutionRhythm,
  type ExecutionRhythm,
  type ExecutionRunSample,
} from '../hooks/useExecutionRhythm';

export interface UniverseAgentNode {
  id: string;
  dependsOn: string[];
  requiredByDefault: boolean;
  executed?: boolean;
  failed?: boolean;
}

export type UniverseAgentRun = ExecutionRunSample;

interface NexaLivingUniverseProps {
  coreState: CoreState;
  activeEnv: EnvironmentId;
  lang?: UiLang;
  lowPowerMode?: boolean;
  agents?: UniverseAgentNode[];
  agentRunsRaw?: UniverseAgentRun[];
  zenInspect?: boolean;
  audioLevel?: number;
}

interface PhysicsProfile {
  primaryHex: number;
  secondaryHex: number;
  speed: number;
  energy: number;
  scaleBias: number;
  particleSpread: number;
  cssColor: string;
  secondaryCss: string;
  textClass: string;
}

const STATE_PHYSICS: Record<CoreState, PhysicsProfile> = {
  dormant: {
    primaryHex: 0x38bdf8,
    secondaryHex: 0x475569,
    speed: 0.24,
    energy: 0.22,
    scaleBias: 0.96,
    particleSpread: 1.08,
    cssColor: '#38BDF8',
    secondaryCss: '#64748B',
    textClass: 'text-sky-400',
  },
  aware: {
    primaryHex: 0x38bdf8,
    secondaryHex: 0x8b5cf6,
    speed: 0.52,
    energy: 0.44,
    scaleBias: 1.0,
    particleSpread: 1.0,
    cssColor: '#38BDF8',
    secondaryCss: '#8B5CF6',
    textClass: 'text-sky-300',
  },
  listening: {
    primaryHex: 0x60a5fa,
    secondaryHex: 0x8b5cf6,
    speed: 0.88,
    energy: 0.72,
    scaleBias: 0.94,
    particleSpread: 0.88,
    cssColor: '#60A5FA',
    secondaryCss: '#8B5CF6',
    textClass: 'text-blue-300',
  },
  reasoning: {
    primaryHex: 0x8b5cf6,
    secondaryHex: 0x38bdf8,
    speed: 1.38,
    energy: 0.86,
    scaleBias: 1.03,
    particleSpread: 0.94,
    cssColor: '#A78BFA',
    secondaryCss: '#38BDF8',
    textClass: 'text-violet-300',
  },
  collaborating: {
    primaryHex: 0x22d3ee,
    secondaryHex: 0x8b5cf6,
    speed: 1.65,
    energy: 0.94,
    scaleBias: 1.05,
    particleSpread: 1.14,
    cssColor: '#22D3EE',
    secondaryCss: '#8B5CF6',
    textClass: 'text-cyan-300',
  },
  executing: {
    primaryHex: 0x34d399,
    secondaryHex: 0x38bdf8,
    speed: 1.95,
    energy: 1.0,
    scaleBias: 1.07,
    particleSpread: 1.06,
    cssColor: '#34D399',
    secondaryCss: '#38BDF8',
    textClass: 'text-emerald-300',
  },
  speaking: {
    primaryHex: 0x7dd3fc,
    secondaryHex: 0xa78bfa,
    speed: 1.12,
    energy: 0.78,
    scaleBias: 1.02,
    particleSpread: 1.02,
    cssColor: '#7DD3FC',
    secondaryCss: '#A78BFA',
    textClass: 'text-sky-200',
  },
  completed: {
    primaryHex: 0x34d399,
    secondaryHex: 0xcbd5e1,
    speed: 0.58,
    energy: 0.6,
    scaleBias: 1.01,
    particleSpread: 1.04,
    cssColor: '#34D399',
    secondaryCss: '#CBD5E1',
    textClass: 'text-emerald-300',
  },
  failed: {
    primaryHex: 0xfb7185,
    secondaryHex: 0xf59e0b,
    speed: 0.36,
    energy: 0.54,
    scaleBias: 0.9,
    particleSpread: 0.84,
    cssColor: '#FB7185',
    secondaryCss: '#F59E0B',
    textClass: 'text-rose-300',
  },
};

interface DomainFieldMorph {
  ring1TiltX: number;
  ring2TiltY: number;
  ring3TiltX: number;
  orbitRadiusMult: number;
  yFlatten: number;
  camOffsetX: number;
  camOffsetY: number;
  camZ: number;
}

const DOMAIN_MORPHS: Record<EnvironmentId, DomainFieldMorph> = {
  genesis: { ring1TiltX: Math.PI / 3.1, ring2TiltY: Math.PI / 4, ring3TiltX: Math.PI / 2.1, orbitRadiusMult: 1.0, yFlatten: 1.0, camOffsetX: 0, camOffsetY: 0.42, camZ: 5.7 },
  command: { ring1TiltX: Math.PI / 3.4, ring2TiltY: Math.PI / 3.2, ring3TiltX: Math.PI / 2.2, orbitRadiusMult: 1.04, yFlatten: 0.95, camOffsetX: 1.35, camOffsetY: 0.2, camZ: 6.4 },
  network: { ring1TiltX: Math.PI / 2.1, ring2TiltY: 0.18, ring3TiltX: Math.PI / 2.0, orbitRadiusMult: 1.24, yFlatten: 0.55, camOffsetX: 1.15, camOffsetY: 0.15, camZ: 6.6 },
  models: { ring1TiltX: 0.45, ring2TiltY: Math.PI / 2.1, ring3TiltX: 1.25, orbitRadiusMult: 1.08, yFlatten: 0.85, camOffsetX: 1.45, camOffsetY: 0.2, camZ: 6.7 },
  research: { ring1TiltX: Math.PI / 2.15, ring2TiltY: 0.35, ring3TiltX: Math.PI / 1.95, orbitRadiusMult: 1.18, yFlatten: 0.65, camOffsetX: 1.4, camOffsetY: 0.2, camZ: 6.6 },
  memory: { ring1TiltX: Math.PI / 2, ring2TiltY: 0, ring3TiltX: Math.PI / 2, orbitRadiusMult: 1.1, yFlatten: 1.35, camOffsetX: 1.45, camOffsetY: 0.1, camZ: 6.6 },
  quant: { ring1TiltX: 0.25, ring2TiltY: Math.PI / 2.4, ring3TiltX: Math.PI / 2.8, orbitRadiusMult: 1.15, yFlatten: 0.72, camOffsetX: 1.5, camOffsetY: 0.2, camZ: 6.7 },
  commerce: { ring1TiltX: Math.PI / 3.6, ring2TiltY: Math.PI / 3.6, ring3TiltX: Math.PI / 2.2, orbitRadiusMult: 1.08, yFlatten: 0.9, camOffsetX: 1.45, camOffsetY: 0.2, camZ: 6.7 },
  engineering: { ring1TiltX: 0, ring2TiltY: Math.PI / 2, ring3TiltX: Math.PI / 2, orbitRadiusMult: 1.02, yFlatten: 1.0, camOffsetX: 1.45, camOffsetY: 0.15, camZ: 6.6 },
  analytics: { ring1TiltX: 0.6, ring2TiltY: 0.8, ring3TiltX: 1.4, orbitRadiusMult: 1.12, yFlatten: 0.8, camOffsetX: 1.5, camOffsetY: 0.2, camZ: 6.8 },
  security: { ring1TiltX: Math.PI / 4, ring2TiltY: Math.PI / 4, ring3TiltX: Math.PI / 2, orbitRadiusMult: 0.92, yFlatten: 0.95, camOffsetX: 1.5, camOffsetY: 0.2, camZ: 6.7 },
  control: { ring1TiltX: Math.PI / 3, ring2TiltY: Math.PI / 3, ring3TiltX: Math.PI / 2, orbitRadiusMult: 0.98, yFlatten: 0.95, camOffsetX: 1.5, camOffsetY: 0.2, camZ: 6.7 },
};

const HARMONIC_VERT = `
  varying vec3 vNormal;
  varying vec3 vViewPos;
  varying vec3 vLocalPos;
  uniform float uTime;
  uniform float uEnergy;
  uniform float uAudio;
  uniform float uHeartbeat;
  void main() {
    vLocalPos = position;
    float waveA = sin(position.x * 4.5 + uTime * 2.1) * cos(position.y * 4.5 - uTime * 1.6);
    float waveB = cos(position.z * 6.0 - uTime * 2.8) * 0.5;
    float amp = (0.022 * uEnergy) + (0.045 * uAudio) + (0.055 * uHeartbeat);
    vec3 displaced = position + normal * (((waveA + waveB) * amp) + (uHeartbeat * 0.042));
    vec4 mvPos = modelViewMatrix * vec4(displaced, 1.0);
    vNormal = normalize(normalMatrix * normal);
    vViewPos = -mvPos.xyz;
    gl_Position = projectionMatrix * mvPos;
  }
`;

const HARMONIC_FRAG = `
  varying vec3 vNormal;
  varying vec3 vViewPos;
  varying vec3 vLocalPos;
  uniform vec3 uColor;
  uniform vec3 uSecondary;
  uniform float uEnergy;
  uniform float uAudio;
  uniform float uHeartbeat;
  uniform float uTime;
  void main() {
    vec3 n = normalize(vNormal);
    vec3 v = normalize(vViewPos);
    float fresnel = pow(1.0 - max(dot(n, v), 0.0), 2.6);
    float band = 0.5 + 0.5 * sin(vLocalPos.z * 7.5 - uTime * 2.4 + vLocalPos.x * 3.0);
    vec3 col = mix(uColor, uSecondary, band * 0.42);
    float alpha = clamp(fresnel * (0.34 + 0.42 * uEnergy + 0.28 * uAudio + 0.32 * uHeartbeat) + 0.025 + (0.05 * uHeartbeat), 0.0, 0.9);
    gl_FragColor = vec4(col * (1.0 + 0.35 * uEnergy + 0.3 * uAudio + 0.48 * uHeartbeat), alpha);
  }
`;

// Pre-allocated zero-GC scratch helpers at module scope
const _initColor = new THREE.Color(0x64748b);
const _colPrimary = new THREE.Color();
const _colSecondary = new THREE.Color();
const _nodeCol = new THREE.Color();
const _dummy = new THREE.Object3D();
const _indexById = new Map<string, number>();

function createVernierCoordinateTexture(maxAnisotropy: number): THREE.CanvasTexture {
  const size = 1024;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const cx = size / 2;
    const cy = size / 2;
    ctx.clearRect(0, 0, size, size);

    // Outer calibrated meridian hairline
    ctx.strokeStyle = 'rgba(203, 213, 225, 0.45)';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.arc(cx, cy, 468, 0, Math.PI * 2);
    ctx.stroke();

    ctx.strokeStyle = 'rgba(56, 189, 248, 0.28)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.arc(cx, cy, 396, 0, Math.PI * 2);
    ctx.stroke();

    // 72 precision vernier ticks (every 5 degrees)
    for (let i = 0; i < 72; i++) {
      const ang = (i / 72) * Math.PI * 2;
      const major = i % 6 === 0;
      const rIn = major ? 430 : 450;
      const rOut = 468;
      ctx.strokeStyle = major ? 'rgba(244, 246, 250, 0.72)' : 'rgba(148, 163, 184, 0.36)';
      ctx.lineWidth = major ? 2.2 : 1.0;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(ang) * rIn, cy + Math.sin(ang) * rIn);
      ctx.lineTo(cx + Math.cos(ang) * rOut, cy + Math.sin(ang) * rOut);
      ctx.stroke();
    }

    // Subtle spectral violet harmonic arcs at opposing quadrants
    ctx.strokeStyle = 'rgba(139, 92, 246, 0.42)';
    ctx.lineWidth = 2.0;
    ctx.beginPath();
    ctx.arc(cx, cy, 412, -0.35, 0.35);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, 412, Math.PI - 0.35, Math.PI + 0.35);
    ctx.stroke();
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = Math.min(maxAnisotropy || 1, 8);
  tex.needsUpdate = true;
  return tex;
}

export function NexaLivingUniverse({
  coreState,
  activeEnv,
  lowPowerMode = false,
  agents = [],
  agentRunsRaw = [],
  zenInspect = false,
  audioLevel = 0,
}: NexaLivingUniverseProps) {
  const executionRhythm = useExecutionRhythm(agentRunsRaw, coreState);
  const mountRef = useRef<HTMLDivElement | null>(null);
  const stateRef = useRef<CoreState>(coreState);
  const envRef = useRef<EnvironmentId>(activeEnv);
  const agentsRef = useRef<UniverseAgentNode[]>(agents);
  const rhythmRef = useRef<ExecutionRhythm>(executionRhythm);
  const heartbeatImpulseRef = useRef<number>(0);
  const lastPulseNonceRef = useRef<number>(0);
  const zenRef = useRef<boolean>(zenInspect);
  const audioRef = useRef<number>(audioLevel);
  const pointerRef = useRef({ x: 0, y: 0 });
  const [webglError, setWebglError] = useState(false);

  useEffect(() => {
    stateRef.current = coreState;
  }, [coreState]);

  useEffect(() => {
    envRef.current = activeEnv;
  }, [activeEnv]);

  useEffect(() => {
    agentsRef.current = agents;
  }, [agents]);

  useEffect(() => {
    rhythmRef.current = executionRhythm;
    if (executionRhythm.pulseNonce > lastPulseNonceRef.current) {
      lastPulseNonceRef.current = executionRhythm.pulseNonce;
      heartbeatImpulseRef.current = 1.0;
    }
  }, [executionRhythm]);

  useEffect(() => {
    zenRef.current = zenInspect;
  }, [zenInspect]);

  useEffect(() => {
    audioRef.current = audioLevel;
  }, [audioLevel]);

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      pointerRef.current.x = (e.clientX / Math.max(window.innerWidth, 1) - 0.5) * 2;
      pointerRef.current.y = (e.clientY / Math.max(window.innerHeight, 1) - 0.5) * 2;
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    return () => window.removeEventListener('pointermove', onMove);
  }, []);

  useEffect(() => {
    if (lowPowerMode) return;
    const container = mountRef.current;
    if (!container) return;

    let renderer: THREE.WebGLRenderer | null = null;
    let frameId = 0;
    let timerId = 0;
    let disposed = false;
    let pmrem: THREE.PMREMGenerator | null = null;
    let envTarget: THREE.WebGLRenderTarget | null = null;

    const width = Math.max(container.clientWidth || window.innerWidth, 320);
    const height = Math.max(container.clientHeight || window.innerHeight, 320);
    const isMobile = width < 768;

    try {
      renderer = new THREE.WebGLRenderer({
        antialias: !isMobile,
        alpha: true,
        powerPreference: 'high-performance',
      });
    } catch {
      setWebglError(true);
      return;
    }

    const gl = renderer.getContext() as WebGL2RenderingContext;
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    const glRenderer = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) || '') : '';
    const isSoftwareGl = /SwiftShader|llvmpipe|softpipe|Software|Basic Render/i.test(glRenderer);

    renderer.setSize(width, height);
    renderer.setPixelRatio(isSoftwareGl ? 1 : Math.min(window.devicePixelRatio || 1, isMobile ? 1.5 : 2));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.08;
    renderer.outputColorSpace = THREE.SRGBColorSpace;

    container.innerHTML = '';
    container.appendChild(renderer.domElement);

    const handleContextLost = (e: Event) => {
      e.preventDefault();
      cancelAnimationFrame(frameId);
      clearTimeout(timerId);
      setWebglError(true);
    };
    const handleContextRestored = () => setWebglError(false);
    renderer.domElement.addEventListener('webglcontextlost', handleContextLost);
    renderer.domElement.addEventListener('webglcontextrestored', handleContextRestored);

    const scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0x030508, 0.045);

    const camera = new THREE.PerspectiveCamera(39, width / height, 0.1, 100);
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    camera.position.set(0, 0.42, reduceMotion ? 5.7 : 8.2);
    camera.lookAt(0, 0, 0);

    pmrem = new THREE.PMREMGenerator(renderer);
    const room = new RoomEnvironment();
    envTarget = pmrem.fromScene(room, 0.04);
    scene.environment = envTarget.texture;
    room.dispose();

    // Calibrated 3-point obsidian observatory lighting (warm/cool specular balance)
    const hemi = new THREE.HemisphereLight(0xcbd5e1, 0x0f172a, 0.65);
    const keyLight = new THREE.DirectionalLight(0x7dd3fc, 1.9);
    keyLight.position.set(4.8, 5.6, 4.2);
    const violetRim = new THREE.DirectionalLight(0x8b5cf6, 0.95);
    violetRim.position.set(-4.6, -2.8, -3.5);
    scene.add(hemi, keyLight, violetRim);

    const sculptureGroup = new THREE.Group();
    scene.add(sculptureGroup);

    // 1. Liquid Metallic Silver Inner Jewel Core
    const jewelGeo = new THREE.OctahedronGeometry(0.24, 0);
    const jewelMat = new THREE.MeshPhysicalMaterial({
      color: 0xe2e8f0,
      emissive: 0x38bdf8,
      emissiveIntensity: 0.25,
      metalness: 0.96,
      roughness: 0.12,
      clearcoat: 1.0,
    });
    const jewelMesh = new THREE.Mesh(jewelGeo, jewelMat);
    sculptureGroup.add(jewelMesh);

    // 2. Geodesic Reference Lattice
    const corePolyGeo = new THREE.IcosahedronGeometry(0.41, 1);
    const corePolyMat = new THREE.MeshBasicMaterial({
      color: 0xcbd5e1,
      wireframe: true,
      transparent: true,
      opacity: 0.28,
    });
    const corePolyMesh = new THREE.Mesh(corePolyGeo, corePolyMat);
    sculptureGroup.add(corePolyMesh);

    // 3. Monumental Iridescent (3,5) Torus-Knot Singularity Shell
    const knotGeo = new THREE.TorusKnotGeometry(0.68, 0.105, isMobile ? 128 : 196, isMobile ? 16 : 24, 3, 5);
    const knotMat = new THREE.MeshPhysicalMaterial({
      color: 0x0b1120,
      emissive: 0x38bdf8,
      emissiveIntensity: 0.36,
      metalness: 0.88,
      roughness: 0.18,
      clearcoat: 0.9,
      clearcoatRoughness: 0.12,
      iridescence: isSoftwareGl ? 0 : 0.92,
      iridescenceIOR: 1.38,
    });
    const knotMesh = new THREE.Mesh(knotGeo, knotMat);
    sculptureGroup.add(knotMesh);

    // 4. Custom GLSL Harmonic Fresnel Wave Membrane
    const veilGeo = new THREE.IcosahedronGeometry(1.03, 2);
    const veilMat = new THREE.ShaderMaterial({
      vertexShader: HARMONIC_VERT,
      fragmentShader: HARMONIC_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uTime: { value: 0 },
        uEnergy: { value: 0.45 },
        uAudio: { value: 0 },
        uHeartbeat: { value: 0 },
        uColor: { value: new THREE.Color(0x38bdf8) },
        uSecondary: { value: new THREE.Color(0x8b5cf6) },
      },
    });
    const veilMesh = new THREE.Mesh(veilGeo, veilMat);
    sculptureGroup.add(veilMesh);

    // 5. Procedural High-DPI Equatorial Vernier Coordinate Disk
    const vernierTex = createVernierCoordinateTexture(renderer.capabilities.getMaxAnisotropy());
    const vernierGeo = new THREE.RingGeometry(1.08, 2.26, 96);
    const vernierMat = new THREE.MeshBasicMaterial({
      map: vernierTex,
      transparent: true,
      opacity: 0.72,
      side: THREE.DoubleSide,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    });
    const vernierDisk = new THREE.Mesh(vernierGeo, vernierMat);
    vernierDisk.rotation.x = Math.PI / 2.25;
    sculptureGroup.add(vernierDisk);

    // 6. Three Folding Archimedean Gimbal Rings
    const ringGeo1 = new THREE.TorusGeometry(1.36, 0.012, 12, 128);
    const ringMat1 = new THREE.MeshStandardMaterial({
      color: 0xe2e8f0,
      emissive: 0x38bdf8,
      emissiveIntensity: 0.22,
      metalness: 0.94,
      roughness: 0.18,
    });
    const ring1 = new THREE.Mesh(ringGeo1, ringMat1);
    sculptureGroup.add(ring1);

    const ringGeo2 = new THREE.TorusGeometry(1.7, 0.009, 12, 128);
    const ringMat2 = new THREE.MeshStandardMaterial({
      color: 0x94a3b8,
      emissive: 0x8b5cf6,
      emissiveIntensity: 0.22,
      metalness: 0.9,
      roughness: 0.25,
    });
    const ring2 = new THREE.Mesh(ringGeo2, ringMat2);
    sculptureGroup.add(ring2);

    const ringGeo3 = new THREE.TorusGeometry(2.06, 0.006, 10, 144);
    const ringMat3 = new THREE.MeshBasicMaterial({
      color: 0x64748b,
      transparent: true,
      opacity: 0.36,
    });
    const ring3 = new THREE.Mesh(ringGeo3, ringMat3);
    sculptureGroup.add(ring3);

    // 7. Real-Data-Driven 15 Specialist Orbital Nodes (InstancedMesh = 1 draw call)
    const MAX_NODES = 15;
    const nodeGeo = new THREE.OctahedronGeometry(0.052, 0);
    const nodeMat = new THREE.MeshStandardMaterial({
      color: 0xe2e8f0,
      emissive: 0x38bdf8,
      emissiveIntensity: 0.45,
      metalness: 0.82,
      roughness: 0.2,
    });
    const nodeInstanced = new THREE.InstancedMesh(nodeGeo, nodeMat, MAX_NODES);
    nodeInstanced.frustumCulled = false;
    nodeInstanced.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    for (let i = 0; i < MAX_NODES; i++) {
      nodeInstanced.setColorAt(i, _initColor);
    }
    if (nodeInstanced.instanceColor) nodeInstanced.instanceColor.needsUpdate = true;
    sculptureGroup.add(nodeInstanced);

    // 8. Real Topological Dependency Filaments (allocated max 45 edges = 90 vertices)
    const MAX_EDGES = 45;
    const edgePositions = new Float32Array(MAX_EDGES * 2 * 3);
    const edgeGeo = new THREE.BufferGeometry();
    const edgeAttr = new THREE.BufferAttribute(edgePositions, 3);
    edgeAttr.setUsage(THREE.DynamicDrawUsage);
    edgeGeo.setAttribute('position', edgeAttr);
    edgeGeo.setDrawRange(0, 0);
    const edgeMat = new THREE.LineBasicMaterial({
      color: 0x38bdf8,
      transparent: true,
      opacity: 0.3,
    });
    const edgeLines = new THREE.LineSegments(edgeGeo, edgeMat);
    edgeLines.frustumCulled = false;
    sculptureGroup.add(edgeLines);

    // 9. Adaptive Particle Field (0 on softwareGL, 550 mobile, 1600 desktop GPU)
    const particleCount = isSoftwareGl ? 0 : isMobile ? 550 : 1600;
    let pointsMesh: THREE.Points | null = null;
    let ptsGeo: THREE.BufferGeometry | null = null;
    let ptsMat: THREE.PointsMaterial | null = null;

    if (particleCount > 0) {
      const pPos = new Float32Array(particleCount * 3);
      for (let i = 0; i < particleCount; i++) {
        const layer = i % 3;
        const r = 1.95 + layer * 0.55 + ((i * 17) % 100) * 0.012;
        const theta = (i * 2.399963) % (Math.PI * 2);
        const phi = Math.acos(1 - (2 * (i + 0.5)) / particleCount);
        pPos[i * 3] = r * Math.sin(phi) * Math.cos(theta);
        pPos[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta) * 0.72;
        pPos[i * 3 + 2] = r * Math.cos(phi);
      }
      ptsGeo = new THREE.BufferGeometry();
      ptsGeo.setAttribute('position', new THREE.BufferAttribute(pPos, 3));
      ptsMat = new THREE.PointsMaterial({
        color: 0x94a3b8,
        size: isMobile ? 0.022 : 0.018,
        transparent: true,
        opacity: 0.44,
      });
      pointsMesh = new THREE.Points(ptsGeo, ptsMat);
      sculptureGroup.add(pointsMesh);
    }

    const clock = new THREE.Clock();
    const _nodeCoords: Array<[number, number, number]> = Array.from({ length: MAX_NODES }, () => [0, 0, 0]);

    let smoothedEnergy = 0.45;
    let smoothedAudio = 0;
    let smoothedHeartbeat = 0;
    let beatPhase = 0;
    let smoothedSpread = 1.0;
    let smoothedOrbitMult = 1.0;
    let smoothedFlatten = 1.0;
    let camX = 0;
    let camY = 0.42;
    let camZ = reduceMotion ? 5.7 : 8.2;

    if (!isSoftwareGl) {
      renderer.compile(scene, camera);
    }

    // Proper WebGL2 fenceSync afterDraw pacing on software GL
    function afterDraw(cb: () => void) {
      if (disposed || typeof gl.fenceSync !== 'function') {
        timerId = window.setTimeout(cb, 80);
        return;
      }
      const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
      gl.flush();
      const poll = () => {
        if (disposed) {
          if (sync) gl.deleteSync(sync);
          return;
        }
        const state = sync && gl.getSyncParameter(sync, gl.SYNC_STATUS);
        if (state === gl.UNSIGNALED) {
          timerId = window.setTimeout(poll, 5);
        } else {
          if (sync) gl.deleteSync(sync);
          timerId = window.setTimeout(cb, 80);
        }
      };
      timerId = window.setTimeout(poll, 5);
    }

    const tick = () => {
      if (disposed || !renderer) return;
      if (document.hidden) {
        timerId = window.setTimeout(() => {
          if (!disposed) frameId = requestAnimationFrame(tick);
        }, 250);
        return;
      }

      const delta = Math.min(clock.getDelta(), 0.05);
      const elapsed = clock.getElapsedTime();

      const phys = STATE_PHYSICS[stateRef.current];
      const morph = DOMAIN_MORPHS[envRef.current];
      const speed = reduceMotion ? 0.06 : phys.speed;

      // Dynamic breathing & cardiac heartbeat driven by useExecutionRhythm(agentRunsRaw, coreState)
      const rhythm = rhythmRef.current;

      // Decay discrete impulse injected on agentRunsRaw updates
      const impulse = heartbeatImpulseRef.current;
      if (impulse > 0.001) {
        heartbeatImpulseRef.current = THREE.MathUtils.damp(impulse, 0, 3.2, delta);
      } else {
        heartbeatImpulseRef.current = 0;
      }

      // Bi-phasic lub-dub cardiac wave scaled by dynamic cadenceHz & pulseIntensity from active agent runs
      const beatRateHz = reduceMotion ? 0.25 : rhythm.cadenceHz;
      beatPhase = (beatPhase + delta * beatRateHz) % 1;
      const lub = Math.exp(-Math.pow((beatPhase - 0.14) / 0.068, 2));
      const dub = 0.62 * Math.exp(-Math.pow((beatPhase - 0.33) / 0.085, 2));
      const targetHeartbeat = Math.min(1.4, (lub + dub) * rhythm.pulseIntensity + heartbeatImpulseRef.current * 0.95);
      smoothedHeartbeat = THREE.MathUtils.damp(smoothedHeartbeat, targetHeartbeat, 14, delta);

      smoothedEnergy = THREE.MathUtils.damp(smoothedEnergy, phys.energy, 4.5, delta);
      smoothedAudio = THREE.MathUtils.damp(smoothedAudio, audioRef.current, 10, delta);
      smoothedSpread = THREE.MathUtils.damp(smoothedSpread, phys.particleSpread, 3.5, delta);
      smoothedOrbitMult = THREE.MathUtils.damp(smoothedOrbitMult, morph.orbitRadiusMult, 4.0, delta);
      smoothedFlatten = THREE.MathUtils.damp(smoothedFlatten, morph.yFlatten, 4.0, delta);

      const mobileNow = (container.clientWidth || window.innerWidth) < 1024;
      const zenNow = zenRef.current;
      const targetCamX = mobileNow || zenNow ? 0 : morph.camOffsetX;
      const targetCamY = zenNow ? 0.05 : mobileNow ? (envRef.current === 'genesis' ? 0.34 : 0.1) : morph.camOffsetY;
      const targetCamZ = zenNow ? 4.85 : mobileNow ? 6.2 : morph.camZ;

      camX = THREE.MathUtils.damp(camX, targetCamX, 4.2, delta);
      camY = THREE.MathUtils.damp(camY, targetCamY, 4.2, delta);
      camZ = THREE.MathUtils.damp(camZ, targetCamZ, 4.2, delta);
      camera.position.set(camX, camY, camZ);
      camera.lookAt(camX * 0.35, 0, 0);

      _colPrimary.setHex(phys.primaryHex);
      _colSecondary.setHex(phys.secondaryHex);

      jewelMat.emissive.lerp(_colPrimary, 0.06);
      jewelMat.emissiveIntensity = 0.25 + smoothedEnergy * 0.45 + smoothedAudio * 0.6 + smoothedHeartbeat * 1.15;
      knotMat.emissive.lerp(_colPrimary, 0.06);
      knotMat.emissiveIntensity = 0.26 + smoothedEnergy * 0.44 + smoothedAudio * 0.35 + smoothedHeartbeat * 0.58;
      corePolyMat.opacity = Math.min(0.85, 0.26 + smoothedHeartbeat * 0.36);
      ringMat1.emissive.lerp(_colPrimary, 0.06);
      ringMat1.emissiveIntensity = 0.22 + smoothedHeartbeat * 0.42;
      ringMat2.emissive.lerp(_colSecondary, 0.06);
      ringMat2.emissiveIntensity = 0.22 + smoothedHeartbeat * 0.3;
      edgeMat.color.lerp(_colPrimary, 0.06);
      edgeMat.opacity = Math.min(0.75, 0.28 + smoothedHeartbeat * 0.28);

      veilMat.uniforms.uTime.value = elapsed;
      veilMat.uniforms.uEnergy.value = smoothedEnergy;
      veilMat.uniforms.uAudio.value = smoothedAudio;
      veilMat.uniforms.uHeartbeat.value = smoothedHeartbeat;
      (veilMat.uniforms.uColor.value as THREE.Color).lerp(_colPrimary, 0.06);
      (veilMat.uniforms.uSecondary.value as THREE.Color).lerp(_colSecondary, 0.06);

      const harmonicScale =
        phys.scaleBias +
        smoothedAudio * 0.12 +
        smoothedHeartbeat * 0.072 +
        (stateRef.current === 'listening' || stateRef.current === 'speaking'
          ? Math.sin(elapsed * 5.2) * 0.028
          : Math.sin(elapsed * 1.4) * 0.012);

      knotMesh.scale.setScalar(harmonicScale);
      jewelMesh.scale.setScalar(1.0 + smoothedHeartbeat * 0.24);
      corePolyMesh.scale.setScalar(1.0 + smoothedHeartbeat * 0.09);
      knotMesh.rotation.y += delta * 0.26 * speed;
      knotMesh.rotation.x += delta * 0.12 * speed;
      jewelMesh.rotation.y -= delta * 0.55 * speed;
      jewelMesh.rotation.z += delta * 0.32 * speed;
      corePolyMesh.rotation.y -= delta * 0.34 * speed;
      vernierDisk.rotation.z += delta * 0.07 * speed;

      ring1.rotation.x = THREE.MathUtils.damp(ring1.rotation.x, morph.ring1TiltX, 3.2, delta);
      ring1.rotation.z += delta * 0.38 * speed;
      ring2.rotation.y = THREE.MathUtils.damp(ring2.rotation.y, morph.ring2TiltY, 3.2, delta);
      ring2.rotation.x -= delta * 0.3 * speed;
      ring3.rotation.x = THREE.MathUtils.damp(ring3.rotation.x, morph.ring3TiltX, 3.2, delta);
      ring3.rotation.z += delta * 0.14 * speed;

      if (pointsMesh) {
        pointsMesh.rotation.y += delta * 0.075 * speed;
        pointsMesh.scale.set(smoothedSpread, smoothedSpread, smoothedSpread);
      }

      const targetYaw = pointerRef.current.x * (zenNow ? 0.38 : 0.22);
      const targetPitch = pointerRef.current.y * (zenNow ? 0.24 : 0.14);
      sculptureGroup.rotation.y = THREE.MathUtils.damp(sculptureGroup.rotation.y, targetYaw, 3.8, delta);
      sculptureGroup.rotation.x = THREE.MathUtils.damp(sculptureGroup.rotation.x, targetPitch, 3.8, delta);

      // Zero-GC 15 Specialist Orbital Nodes + Real Topological Edges
      const activeAgents = agentsRef.current;
      const nodeCount = activeAgents.length > 0 ? Math.min(activeAgents.length, MAX_NODES) : MAX_NODES;
      _indexById.clear();

      for (let i = 0; i < nodeCount; i++) {
        const meta = activeAgents[i];
        if (meta) _indexById.set(meta.id, i);

        const planeIdx = i % 3;
        const baseR = (planeIdx === 0 ? 1.42 : planeIdx === 1 ? 1.76 : 2.12) * smoothedOrbitMult;
        const angle = (i / nodeCount) * Math.PI * 2 + elapsed * (0.17 + planeIdx * 0.06) * speed;
        const tilt = planeIdx === 0 ? 0.55 : planeIdx === 1 ? -0.42 : 0.15;

        const x = Math.cos(angle) * baseR;
        const y =
          envRef.current === 'memory'
            ? (i - nodeCount / 2) * 0.16
            : Math.sin(angle) * baseR * Math.sin(tilt) * smoothedFlatten;
        const z = Math.sin(angle) * baseR * Math.cos(tilt);

        _nodeCoords[i][0] = x;
        _nodeCoords[i][1] = y;
        _nodeCoords[i][2] = z;

        const isExecuted = Boolean(meta?.executed);
        const isFailed = Boolean(meta?.failed);
        const isLatestRun = Boolean(meta && rhythm.latestAgentId === meta.id);
        const nodeScale =
          (isExecuted ? 1.35 : meta?.requiredByDefault ? 1.0 : 0.78) * (isLatestRun ? 1 + smoothedHeartbeat * 0.22 : 1 + smoothedHeartbeat * 0.06);
        _dummy.position.set(x, y, z);
        _dummy.scale.setScalar(nodeScale);
        _dummy.rotation.set(elapsed * 0.6 + i, elapsed * 0.4, 0);
        _dummy.updateMatrix();
        nodeInstanced.setMatrixAt(i, _dummy.matrix);

        if (isFailed) _nodeCol.setHex(0xfb7185);
        else if (isExecuted) _nodeCol.setHex(0x34d399);
        else if (meta?.requiredByDefault) _nodeCol.setHex(0x38bdf8);
        else _nodeCol.setHex(0x475569);
        nodeInstanced.setColorAt(i, _nodeCol);
      }
      nodeInstanced.count = nodeCount;
      nodeInstanced.instanceMatrix.needsUpdate = true;
      if (nodeInstanced.instanceColor) nodeInstanced.instanceColor.needsUpdate = true;

      let edgeCursor = 0;
      for (let i = 0; i < nodeCount && edgeCursor < MAX_EDGES; i++) {
        const meta = activeAgents[i];
        if (!meta) continue;
        for (const depId of meta.dependsOn) {
          if (edgeCursor >= MAX_EDGES) break;
          const depIdx = _indexById.get(depId);
          if (depIdx === undefined) continue;
          const p = edgeCursor * 6;
          edgePositions[p] = _nodeCoords[depIdx][0];
          edgePositions[p + 1] = _nodeCoords[depIdx][1];
          edgePositions[p + 2] = _nodeCoords[depIdx][2];
          edgePositions[p + 3] = _nodeCoords[i][0];
          edgePositions[p + 4] = _nodeCoords[i][1];
          edgePositions[p + 5] = _nodeCoords[i][2];
          edgeCursor++;
        }
      }
      edgeGeo.setDrawRange(0, edgeCursor * 2);
      edgeAttr.needsUpdate = true;

      renderer.render(scene, camera);

      if (isSoftwareGl) {
        afterDraw(tick);
      } else {
        frameId = requestAnimationFrame(tick);
      }
    };

    frameId = requestAnimationFrame(tick);

    const onResize = () => {
      if (!container || !renderer) return;
      const w = Math.max(container.clientWidth || window.innerWidth, 320);
      const h = Math.max(container.clientHeight || window.innerHeight, 320);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    };
    window.addEventListener('resize', onResize, { passive: true });

    return () => {
      disposed = true;
      cancelAnimationFrame(frameId);
      clearTimeout(timerId);
      window.removeEventListener('resize', onResize);
      if (renderer) {
        renderer.domElement.removeEventListener('webglcontextlost', handleContextLost);
        renderer.domElement.removeEventListener('webglcontextrestored', handleContextRestored);
      }
      jewelGeo.dispose();
      jewelMat.dispose();
      knotGeo.dispose();
      knotMat.dispose();
      corePolyGeo.dispose();
      corePolyMat.dispose();
      veilGeo.dispose();
      veilMat.dispose();
      vernierTex.dispose();
      vernierGeo.dispose();
      vernierMat.dispose();
      ringGeo1.dispose();
      ringMat1.dispose();
      ringGeo2.dispose();
      ringMat2.dispose();
      ringGeo3.dispose();
      ringMat3.dispose();
      nodeGeo.dispose();
      nodeMat.dispose();
      edgeGeo.dispose();
      edgeMat.dispose();
      ptsGeo?.dispose();
      ptsMat?.dispose();
      envTarget?.dispose();
      pmrem?.dispose();
      renderer?.dispose();
    };
  }, [lowPowerMode]);

  const phys = STATE_PHYSICS[coreState];
  const fallbackRings = useMemo(() => [44, 68, 94], []);

  return (
    <div className="fixed inset-0 z-0 pointer-events-none overflow-hidden bg-[#030508]">
      <div className="absolute inset-0 nexa-coordinate-plane opacity-45" />

      {lowPowerMode || webglError ? (
        <div className="w-full h-full flex items-center justify-center">
          <svg
            viewBox="0 0 260 260"
            className="w-72 h-72 sm:w-96 sm:h-96 opacity-90 transition-transform duration-500 ease-out"
            style={{
              transform: executionRhythm.burstActive || executionRhythm.isActiveExecution
                ? `scale(${(1 + executionRhythm.pulseIntensity * 0.06).toFixed(3)})`
                : 'scale(1)',
            }}
          >
            {fallbackRings.map((r, i) => (
              <circle
                key={r}
                cx="130"
                cy="130"
                r={(executionRhythm.burstActive || executionRhythm.isActiveExecution) && i === 0 ? r + 5 : r}
                fill="none"
                stroke={i === 1 ? phys.secondaryCss : phys.cssColor}
                strokeOpacity={0.28 + i * 0.08 + (executionRhythm.burstActive ? 0.25 : 0)}
                strokeWidth={executionRhythm.burstActive && i === 0 ? '1.6' : '0.95'}
                strokeDasharray={i === 0 ? '4 4' : undefined}
              />
            ))}
            <polygon
              points="130,50 200,130 130,210 60,130"
              fill={phys.cssColor}
              fillOpacity={executionRhythm.burstActive ? '0.2' : '0.06'}
              stroke={phys.cssColor}
              strokeWidth={executionRhythm.burstActive ? '1.8' : '1.2'}
            />
            <polygon
              points="130,78 176,104 176,156 130,182 84,156 84,104"
              fill="none"
              stroke="#CBD5E1"
              strokeOpacity={executionRhythm.burstActive ? '0.85' : '0.52'}
              strokeWidth="1"
            />
            <circle
              cx="130"
              cy="130"
              r={executionRhythm.burstActive ? 16 : 9 + executionRhythm.pulseIntensity * 4}
              fill={phys.cssColor}
              fillOpacity={executionRhythm.burstActive ? '0.52' : '0.24'}
            />
            {(agents.length > 0 ? agents : Array.from({ length: 15 }, (_, i) => ({ id: String(i), executed: false, failed: false }))).map(
              (a, idx, arr) => {
                const ang = (idx / arr.length) * Math.PI * 2 - Math.PI / 2;
                const rad = idx % 2 === 0 ? 94 : 68;
                const cx = 130 + Math.cos(ang) * rad;
                const cy = 130 + Math.sin(ang) * rad;
                const fill = a.failed ? '#FB7185' : a.executed ? '#34D399' : phys.cssColor;
                return <circle key={a.id} cx={cx} cy={cy} r={a.executed ? 3.2 : 2.1} fill={fill} fillOpacity="0.9" />;
              }
            )}
          </svg>
        </div>
      ) : (
        <div ref={mountRef} className="w-full h-full" />
      )}

      {/* Subtle optical scrim so specialized environments remain crisp */}
      <div
        className="absolute inset-0 transition-opacity duration-300"
        style={{
          background:
            activeEnv === 'genesis'
              ? zenInspect
                ? 'radial-gradient(circle at 50% 48%, transparent 32%, rgba(3,5,8,0.42) 85%, rgba(3,5,8,0.85) 100%)'
                : 'radial-gradient(circle at 50% 34%, transparent 20%, rgba(3,5,8,0.5) 78%, rgba(3,5,8,0.88) 100%)'
              : 'linear-gradient(180deg, rgba(3,5,8,0.6) 0%, rgba(3,5,8,0.72) 100%)',
        }}
      />
    </div>
  );
}

// Inline acoustic resonator inside CommandView's Acoustic Voice sub-mode
export function NexaCoreCanvas({
  coreState,
  lang = 'en',
  lowPowerMode = false,
  audioLevel = 0,
}: {
  coreState: CoreState;
  lang?: UiLang;
  lowPowerMode?: boolean;
  audioLevel?: number;
}) {
  const phys = STATE_PHYSICS[coreState];
  const label = I18N[lang].coreStates[coreState];
  const radius = 38 + Math.min(audioLevel, 1) * 26;
  return (
    <div className="relative w-full h-56 bg-[#060911] border border-[#1E2534] rounded-lg flex flex-col items-center justify-center overflow-hidden">
      <div className="absolute inset-0 nexa-coordinate-plane opacity-40" />
      <svg viewBox="0 0 180 180" className="relative z-10 w-36 h-36">
        <circle cx="90" cy="90" r="66" fill="none" stroke={phys.cssColor} strokeOpacity="0.32" strokeWidth="1" />
        <circle
          cx="90"
          cy="90"
          r={radius}
          fill="none"
          stroke={phys.secondaryCss}
          strokeOpacity="0.48"
          strokeWidth="1.2"
          strokeDasharray="5 3"
        />
        <polygon points="90,42 132,90 90,138 48,90" fill={phys.cssColor} fillOpacity="0.08" stroke={phys.cssColor} strokeWidth="1.2" />
        <circle cx="90" cy="90" r={(lowPowerMode ? 7 : 9) + audioLevel * 9} fill={phys.cssColor} fillOpacity="0.48" />
      </svg>
      <div className="relative z-10 font-mono text-[11px] uppercase tracking-wider text-center">
        <span className={phys.textClass}>{label.label}</span>
        <span className="text-[#64748B] ms-2">· {label.detail}</span>
      </div>
    </div>
  );
}
