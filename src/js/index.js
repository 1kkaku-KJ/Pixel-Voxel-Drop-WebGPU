import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { WebGPURenderer, MeshBasicNodeMaterial } from "three/webgpu";
import {
  texture, uniform, instanceIndex, positionLocal, normalLocal,
  attribute, varying,
  float, vec2, vec3, vec4,
  Fn, abs, step, clamp, mix, fract, dot, normalize, smoothstep, floor, mod
} from "three/tsl";
import RAPIER from "@dimforge/rapier3d-compat";
import { gsap } from "gsap";
import { Pane } from "tweakpane";

import videoSource from "../video/output1.mp4";


const STATES = {
  LOADING: "LOADING",
  DEFAULT: "DEFAULT",
  ANIMATING: "ANIMATING",
  COLLAPSED: "COLLAPSED",
  REVERSING: "REVERSING",
};

const BUTTON_STATES = {
  [ STATES.LOADING ]: () => ({ title: "LOADING...", disabled: true }),
  [ STATES.DEFAULT ]: (manual) => ({
    title: manual ? "CLICK ON THE PLANE" : "START EFFECT",
    disabled: manual,
  }),
  [ STATES.COLLAPSED ]: () => ({ title: "BACK TO PLANE", disabled: false }),
  [ STATES.ANIMATING ]: () => ({ title: "ANIMATING...", disabled: true }),
  [ STATES.REVERSING ]: () => ({ title: "RESTORING...", disabled: true }),
};


function debounce (func, wait) {
  let timeout;
  return (...args) => {
    clearTimeout(timeout);
    timeout = setTimeout(() => func.apply(this, args), wait);
  };
}


class PixelVoxelDrop {
  constructor() {
    this.params = this.initializeParams();
    this.settings = this.initializeSettings();
    this.gridInfo = this.initializeGridInfo();
    this.rigidBodies = [];
    this.cachedReverseData = [];
    this.pendingDropIndices = [];
    this.state = STATES.LOADING;
    this.actionButton = null;
    this.video = null;
    this.videoTexture = null;
    this.activeRigidBody = null;
    this.joint = null;
    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this.intersectionPoint = new THREE.Vector3();
    this.dummy = new THREE.Object3D();

    this.onWindowResize = this.onWindowResize.bind(this);
    this.rebuildWorld = debounce(this.rebuildWorld.bind(this), 300);
    this.onPointerDown = this.onPointerDown.bind(this);
    this.onPointerMove = this.onPointerMove.bind(this);
    this.onPointerUp = this.onPointerUp.bind(this);
    this.animate = this.animate.bind(this);

    this.init();
  }

  initializeParams () {
    return {
      gridCols: 100,
      gridSpacing: 1,
      shape: "cube",
      gridCount: "0",
      baseDuration: 2.0,
      usePixelate: true,
      useRGBShift: true,
      elasticMode: false,
      effectSpread: 0.25,
      effectDepth: 1.5,
      highlightColor: "#f2f2f2",
      highlightIntensity: 0.0,
      dropDelay: 0.0,
      isDancing: true,
      dancingLevel: 4,
      manualMode: false,
    };
  }

  initializeSettings () {
    return {
      playbackRate: 1.0,
      fitMargin: 0.55,
      gridOffsetY: 0,
      gravityY: 0,
      bodyRestitution: 1.3,
      bodyDamping: 0.8,
    };
  }

  initializeGridInfo () {
    return { cols: 0, rows: 0, count: 0, width: 0, height: 0, cellSize: 0, spacing: 0 };
  }

  // ==========================================================================
  // INITIALIZATION & SETUP
  // ==========================================================================

  async init () {
    await RAPIER.init();
    await this.setupThree();
    this.setupPhysicsWorld();
    this.setupVideo();
    this.setupGUI();
    this.setupEventListeners();
    this.animate();
  }

  async setupThree () {
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.01, 1000);
    this.camera.position.set(0, 10, 20);
    this.renderer = new WebGPURenderer({ alpha: true, antialias: false });
    await this.renderer.init();
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    document.body.appendChild(this.renderer.domElement);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.05;
    this.controls.zoomSpeed = 1.5;
    this.controls.maxPolarAngle = Math.PI;
    this.controls.maxDistance = 80;
  }

  setupPhysicsWorld () {
    this.world = new RAPIER.World({ x: 0.0, y: 0.0, z: 0.0 });
    const floorThickness = 20.0;
    const groundDesc = RAPIER.RigidBodyDesc.fixed();
    this.groundBody = this.world.createRigidBody(groundDesc);
    const groundColliderDesc = RAPIER.ColliderDesc.cuboid(1000.0, floorThickness / 2, 1000.0)
      .setTranslation(0, -(floorThickness / 2), 0)
      .setFriction(0.1)
      .setRestitution(0.9);
    this.groundCollider = this.world.createCollider(groundColliderDesc, this.groundBody);
    this.colliderToIndex = new Map();

    const mouseDesc = RAPIER.RigidBodyDesc.kinematicPositionBased();
    this.mouseBody = this.world.createRigidBody(mouseDesc);
    this.mouseCollider = null;
  }

  setupVideo () {
    this.video = document.createElement("video");
    this.video.src = videoSource;
    this.video.muted = true;
    this.video.loop = true;
    this.video.crossOrigin = "anonymous";
    this.video.playsInline = true;
    this.video.setAttribute("playsinline", "");
    this.video.style.display = "none";
    document.body.appendChild(this.video);

    this.video.addEventListener("loadeddata", () => this.onVideoReady(), { once: true });
    this.video.load();
  }

  setupGUI () {
    if (this.pane) this.pane.dispose();
    this.pane = new Pane();
    this.debugFolders = {};

    // 1. Grid Settings
    const fGrid = this.pane.addFolder({ title: "Box" });
    fGrid.addBinding(this.params, "gridCols", { label: "Column", min: 10, max: 150, step: 1 }).on("change", this.rebuildWorld);
    fGrid.addBinding(this.params, "gridSpacing", { label: "Space", min: 1.0, max: 2.0, step: 0.1 }).on("change", this.rebuildWorld);
    fGrid.addBinding(this.params, "shape", { label: "Shape", options: { Cube: "cube", RandomBox: "random" } }).on("change", (e) => {
      if (this.mesh) this.tslUniforms.uUseRandomDepth.value = e.value === "random" ? 1.0 : 0.0;
      this.rebuildWorld();
    });
    fGrid.addBinding(this.params, "gridCount", { readonly: true, label: "Count" });
    this.debugFolders.grid = fGrid;

    // 2. Visual Effects
    const fVisual = this.pane.addFolder({ title: "Visual" });
    fVisual.addBinding(this.params, "baseDuration", { label: "Duration", min: 0.5, max: 5.0, step: 0.1 });
    fVisual.addBinding(this.params, "elasticMode", { label: "Organic" }).on("change", (e) => this.updateUniform("uElasticMode", e.value ? 1.0 : 0.0));
    fVisual.addBinding(this.params, "usePixelate", { label: "Pixelate" }).on("change", (e) => this.updateUniform("uUsePixelate", e.value ? 1.0 : 0.0));
    fVisual.addBinding(this.params, "useRGBShift", { label: "RGBShift" }).on("change", (e) => this.updateUniform("uUseRGBShift", e.value ? 1.0 : 0.0));
    fVisual.addBinding(this.params, "effectSpread", { label: "Spread", min: 0.0, max: 0.5, step: 0.05 }).on("change", (e) => this.updateUniform("uEffectSpread", e.value));
    fVisual.addBinding(this.params, "effectDepth", { label: "Depth", min: 1.0, max: 3.0, step: 0.05 }).on("change", (e) => this.updateUniform("uEffectDepth", e.value));
    fVisual.addBinding(this.params, "highlightColor", { label: "Color" }).on("change", (e) => {
      if (this.mesh) this.tslUniforms.uHighlightColor.value.set(e.value);
    });
    fVisual
      .addBinding(this.params, "highlightIntensity", { label: "ColorInt", min: 0.0, max: 1.0, step: 0.05 })
      .on("change", (e) => this.updateUniform("uHighlightIntensity", e.value));
    this.debugFolders.visual = fVisual;

    // 3. Physics
    const fPhysics = this.pane.addFolder({ title: "Physics" });
    fPhysics.addBinding(this.params, "dropDelay", { min: 0, max: 3, step: 0.1, label: "DropDelay" });
    fPhysics.addBinding(this.params, "isDancing", { label: "Dance" }).on("change", () => this.updatePhysicsParameters());
    fPhysics.addBinding(this.params, "dancingLevel", { min: 0, max: 10, step: 1, label: "DanceLV" }).on("change", () => this.updatePhysicsParameters());
    this.debugFolders.physics = fPhysics;

    // 4. Controls
    const fControls = this.pane.addFolder({ title: "Controls" });
    fControls.addBinding(this.params, "manualMode", { label: "Manual" }).on("change", () => this.refreshUIState());
    this.debugFolders.controls = fControls;

    // Action Button
    this.actionButton = this.pane.addButton({
      title: BUTTON_STATES[ STATES.LOADING ]().title,
      disabled: BUTTON_STATES[ STATES.LOADING ]().disabled,
    });
    this.actionButton.on("click", () => this.handleMainAction());

    this.refreshUIState();
  }

  setupEventListeners () {
    this.renderer.domElement.addEventListener("pointerdown", this.onPointerDown);
    this.renderer.domElement.addEventListener("pointermove", this.onPointerMove);
    this.renderer.domElement.addEventListener("pointerup", this.onPointerUp);
    window.addEventListener("resize", this.onWindowResize);
  }

  // ==========================================================================
  // CORE LOGIC: WORLD BUILDING
  // ==========================================================================

  onVideoReady () {
    if (this.buildScene()) {
      this.video
        .play()
        .then(() => {
          this.video.pause();
          this.video.currentTime = 0;
          this.adjustCameraPosition();
          this.fadeoutLoadingScreen();
          this.changeState(STATES.DEFAULT);
        })
        .catch((e) => console.warn("Autoplay blocked", e));
    }
  }

  rebuildWorld () {
    if (this.state === STATES.ANIMATING || this.state === STATES.REVERSING) return;

    if (this.buildScene()) {
      this.adjustCameraPosition();
      this.changeState(STATES.DEFAULT);
      this.refreshUIState();
    }
  }

  buildScene () {
    if (!this.video.videoWidth) return false;

    this.calculateGridMetrics();
    this.clearPhysicsBodies();
    this.createPixelVoxelMesh();
    this.createGridBodies();

    return true;
  }

  calculateGridMetrics () {
    const { videoWidth, videoHeight } = this.video;
    const aspect = videoWidth / videoHeight;
    const cols = this.params.gridCols;
    const rows = Math.round(cols / aspect);

    const distance = 25;
    const vFovRad = THREE.MathUtils.degToRad(this.camera.fov);
    const visibleHeight = 2 * Math.tan(vFovRad / 2) * distance;
    const visibleWidth = visibleHeight * this.camera.aspect;

    let baseCellSize = (visibleWidth * this.settings.fitMargin) / cols;
    if (baseCellSize * rows > visibleHeight * this.settings.fitMargin) {
      baseCellSize = (visibleHeight * this.settings.fitMargin) / rows;
    }

    const spacing = baseCellSize * this.params.gridSpacing;

    this.gridInfo = {
      cols,
      rows,
      count: cols * rows,
      cellSize: baseCellSize,
      spacing,
      width: cols * spacing,
      height: rows * spacing,
    };

    this.params.gridCount = this.gridInfo.count;

    this.settings.gridOffsetY = this.gridInfo.height;
    this.settings.gravityY = -(this.gridInfo.height * 5.0);
    this.world.gravity = { x: 0, y: this.settings.gravityY, z: 0 };
  }

  createPixelVoxelMesh () {
    if (this.geometry) this.geometry.dispose();
    if (this.posTexture) this.posTexture.dispose();
    if (this.quatTexture) this.quatTexture.dispose();
    if (this.videoTexture) this.videoTexture.dispose();

    this.geometry = new THREE.BoxGeometry(this.gridInfo.cellSize, this.gridInfo.cellSize, this.gridInfo.cellSize);
    const { count, cols, rows } = this.gridInfo;
    this.posData = new Float32Array(count * 4);
    this.quatData = new Float32Array(count * 4);
    this.posTexture = new THREE.DataTexture(this.posData, cols, rows, THREE.RGBAFormat, THREE.FloatType);
    this.posTexture.minFilter = THREE.NearestFilter;
    this.posTexture.magFilter = THREE.NearestFilter;
    this.posTexture.needsUpdate = true;
    this.quatTexture = new THREE.DataTexture(this.quatData, cols, rows, THREE.RGBAFormat, THREE.FloatType);
    this.quatTexture.minFilter = THREE.NearestFilter;
    this.quatTexture.magFilter = THREE.NearestFilter;
    this.quatTexture.needsUpdate = true;
    this.videoTexture = new THREE.VideoTexture(this.video);
    this.videoTexture.colorSpace = THREE.SRGBColorSpace;
    this.videoTexture.minFilter = THREE.NearestFilter;
    this.videoTexture.magFilter = THREE.NearestFilter;

    const randomDepthArray = new Float32Array(count);
    for (let i = 0; i < count; i++) randomDepthArray[ i ] = Math.random() < 0.2 ? 1.0 : 1.0 + Math.random() * 1.5;
    this.geometry.setAttribute('aRandomDepth', new THREE.InstancedBufferAttribute(randomDepthArray, 1));

    // Uniforms as TSL uniform nodes
    this.tslUniforms = {
      uGridDims: uniform(new THREE.Vector2(cols, rows)),
      uCubeSize: uniform(new THREE.Vector2(this.gridInfo.cellSize, this.gridInfo.cellSize)),
      uVoxelateProgress: uniform(0),
      uRippleCenter: uniform(new THREE.Vector2(0.5, 0.5)),
      uEffectSpread: uniform(this.params.effectSpread),
      uEffectDepth: uniform(this.params.effectDepth),
      uOrganicMode: uniform(this.params.elasticMode ? 1 : 0),
      uElasticMode: uniform(this.params.elasticMode ? 1 : 0),
      uUseRandomDepth: uniform(this.params.shape === "random" ? 1 : 0),
      uUsePixelate: uniform(this.params.usePixelate ? 1 : 0),
      uUseRGBShift: uniform(this.params.useRGBShift ? 1 : 0),
      uHighlightColor: uniform(new THREE.Color(this.params.highlightColor)),
      uHighlightIntensity: uniform(this.params.highlightIntensity),
    };

    const posTexNode = texture(this.posTexture);
    const quatTexNode = texture(this.quatTexture);
    const videoTexNode = texture(this.videoTexture);

    const vUvNode = varying(vec2(0, 0), 'vUv');
    const vNormalNode = varying(vec3(0, 0, 1), 'vNormal');
    const vHighlightNode = varying(float(0), 'vHighlightStrength');
    const vGlitchNode = varying(float(0), 'vGlitchStrength');


    const randomFn = Fn(([ st ]) => {
      const d = dot(st, vec2(float(12.9898), float(78.233)));
      const s = d.sin().mul(float(43758.5453123));
      return fract(s);
    });

    const rotateByQuatFn = Fn(([ v, q ]) => {
      const qxyz = vec3(q.x, q.y, q.z);
      const cross1 = qxyz.cross(v);
      const inner = v.mul(q.w).add(cross1);
      const cross2 = qxyz.cross(inner);
      return cross2.mul(float(2.0)).add(v);
    });

    const elasticOutFn = Fn(([ t, p, damp ]) => {
      const tClamped = clamp(t, float(0.0), float(1.0));
      const powTerm = float(2.0).pow(damp.mul(tClamped).mul(float(-1.0)));
      const sinTerm = tClamped.sub(p.div(float(4.0))).mul(float(2.0).mul(float(3.14159265)).div(p)).sin();
      return powTerm.mul(sinTerm).add(float(1.0));
    });

    const positionNode = Fn(() => {
      const instanceId = float(instanceIndex);
      const col = mod(instanceId, this.tslUniforms.uGridDims.x);
      const row = floor(instanceId.div(this.tslUniforms.uGridDims.x));
      const uvStep = vec2(float(1.0).div(this.tslUniforms.uGridDims.x), float(1.0).div(this.tslUniforms.uGridDims.y));
      const baseUv = vec2(col, row).mul(uvStep);
      const fetchUv = vec2(col.add(float(0.5)).div(this.tslUniforms.uGridDims.x), row.add(float(0.5)).div(this.tslUniforms.uGridDims.y));
      const centerUv = baseUv.add(uvStep.mul(float(0.5)));

      const gridAspect = this.tslUniforms.uGridDims.x.div(this.tslUniforms.uGridDims.y);
      const aspectVec = vec2(gridAspect, float(1.0));
      const distFromCenter = centerUv.mul(aspectVec).sub(this.tslUniforms.uRippleCenter.mul(aspectVec)).length();

      const rndPhase = randomFn(vec2(instanceId, float(123.456)));
      const rndBounce = randomFn(vec2(instanceId, float(987.654)));

      const noisyDist = float(0.0).max(distFromCenter.add(rndPhase.sub(float(0.5)).mul(float(0.3))));
      const progressOrganic = clamp(this.tslUniforms.uVoxelateProgress.sub(noisyDist).div(this.tslUniforms.uEffectSpread), float(0.0), float(1.0));

      const suppression = float(1.0).sub(smoothstep(float(0.0), float(0.05), noisyDist));
      const currentDamp = mix(float(6.0), float(2.0), suppression);

      const pVal = float(0.2).add(rndPhase.mul(float(0.2)));
      let valOrganic = elasticOutFn(progressOrganic, pVal, currentDamp);
      const bounceDiff = float(0.0).max(valOrganic.sub(float(1.0)));
      valOrganic = valOrganic.add(bounceDiff.mul(this.tslUniforms.uEffectDepth.add(rndBounce.mul(float(1.1)))));

      const highlightOrganic = step(float(0.01), bounceDiff).mul(smoothstep(float(0.0), float(0.35), float(1.0).sub(progressOrganic))).mul(float(0.5).add(rndPhase.mul(float(0.5))));

      const progressSmooth = smoothstep(distFromCenter, distFromCenter.add(this.tslUniforms.uEffectSpread), this.tslUniforms.uVoxelateProgress);
      const valSmoothBounce = progressSmooth.mul(float(3.14159265)).sin().mul(step(progressSmooth, float(0.99)));
      const valSmooth = progressSmooth.add(valSmoothBounce.mul(this.tslUniforms.uEffectDepth));
      const highlightSmooth = valSmoothBounce;

      const finalScaleVal = mix(valSmooth, valOrganic, this.tslUniforms.uOrganicMode);
      const vHighlight = mix(highlightSmooth, highlightOrganic, this.tslUniforms.uOrganicMode);

      const nMask = step(float(0.5), abs(normalLocal));
      const faceCoords = positionLocal.zy.mul(nMask.x).add(positionLocal.xz.mul(nMask.y)).add(positionLocal.xy.mul(nMask.z));
      const localRatio = clamp(faceCoords.div(this.tslUniforms.uCubeSize.x).add(float(0.5)), float(0.0), float(1.0));
      const smoothUv = baseUv.add(localRatio.mul(uvStep));

      const effectiveProgress = mix(progressSmooth, progressOrganic, this.tslUniforms.uOrganicMode);
      const pixelPhase = smoothstep(float(0.0), float(0.9), effectiveProgress);
      const glitchIntensity = pixelPhase.mul(float(3.14159265)).sin().pow(float(0.5));

      const noiseOffset = vec2(
        randomFn(vec2(instanceId.add(pixelPhase.mul(float(100.0))), float(0.0))),
        randomFn(vec2(instanceId.add(pixelPhase.mul(float(100.0))), float(1.0)))
      ).sub(vec2(float(0.5), float(0.5)));

      const pixelateUv = mix(smoothUv, centerUv, pixelPhase).add(noiseOffset.mul(glitchIntensity).mul(float(0.3)));

      const finalUv = mix(smoothUv, pixelateUv, this.tslUniforms.uUsePixelate);
      const finalGlitch = glitchIntensity.mul(this.tslUniforms.uUseRGBShift);

      vUvNode.assign(finalUv);
      vGlitchNode.assign(finalGlitch);
      vHighlightNode.assign(vHighlight);

      const instancePos = posTexNode.sample(fetchUv).xyz;
      const instanceQuat = quatTexNode.sample(fetchUv);

      const baseDepth = float(0.05);
      const aRandomDepth = attribute('aRandomDepth');
      const targetDepth = mix(float(1.0), aRandomDepth, this.tslUniforms.uUseRandomDepth);
      const currentDepth = baseDepth.add(targetDepth.sub(baseDepth).mul(finalScaleVal));

      let scaledPos = positionLocal;
      scaledPos = vec3(scaledPos.x, scaledPos.y, scaledPos.z.mul(currentDepth));

      const rotatedPos = rotateByQuatFn(scaledPos, instanceQuat);
      const finalPos = rotatedPos.add(instancePos);

      const rotatedNormal = rotateByQuatFn(normalLocal, instanceQuat);
      vNormalNode.assign(normalize(rotatedNormal));

      return finalPos;
    })();

    const colorNode = Fn(() => {
      const shift = vGlitchNode.mul(float(0.075));
      const r = videoTexNode.sample(vUvNode.add(vec2(shift, float(0.0)))).r;
      const g = videoTexNode.sample(vUvNode).g;
      const b = videoTexNode.sample(vUvNode.sub(vec2(shift, float(0.0)))).b;
      const texColor = vec4(r, g, b, float(1.0));

      const LIGHT_DIR = vec3(float(0.8), float(0.85), float(1.0));
      const normLightDir = normalize(LIGHT_DIR);
      const diff = float(0.0).max(vNormalNode.dot(normLightDir));
      const ambient = vec3(float(0.95));
      const diffuse = vec3(float(0.1)).mul(diff);
      const lighting = ambient.add(diffuse);
      let finalColor = texColor.rgb.mul(lighting);
      const effectIntensity = vHighlightNode.mul(this.tslUniforms.uHighlightIntensity);
      finalColor = mix(finalColor, this.tslUniforms.uHighlightColor, effectIntensity);
      return vec4(finalColor, texColor.a);
    })();

    const material = new MeshBasicNodeMaterial();
    material.positionNode = positionNode;
    material.colorNode = colorNode;
    material.side = THREE.DoubleSide;

    if (this.mesh) {
      this.scene.remove(this.mesh);
      this.mesh.geometry.dispose();
    }
    this.mesh = new THREE.Mesh(this.geometry, material);
    this.mesh.count = count;
    this.mesh.frustumCulled = false;
    this.scene.add(this.mesh);
  }

  createGridBodies () {
    this.pendingDropIndices = Array.from({ length: this.gridInfo.count }, (_, i) => i);
    const randomDepths = new Float32Array(this.gridInfo.count);

    const { cols, width, height, spacing, cellSize } = this.gridInfo;
    const startX = -width * 0.5 + spacing * 0.5;
    const startY = -height * 0.5 + spacing * 0.5 + this.settings.gridOffsetY;
    const halfSize = cellSize / 2;

    for (let i = 0; i < this.gridInfo.count; i++) {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const x = startX + col * spacing;
      const y = startY + row * spacing;

      const noiseOffset = this._computeNoiseOffset(i);

      const depthScale = this.params.shape === "random" ? (Math.random() < 0.2 ? 1.0 : 1.0 + Math.random() * 1.5) : 1.0;
      randomDepths[ i ] = depthScale;

      const rbDesc = RAPIER.RigidBodyDesc.fixed().setTranslation(x, y, 0).setLinearDamping(this.settings.bodyDamping).setAngularDamping(this.settings.bodyDamping);
      const rb = this.world.createRigidBody(rbDesc);

      const clDesc = RAPIER.ColliderDesc.cuboid(halfSize, halfSize, halfSize * depthScale)
        .setFriction(0.0)
        .setRestitution(this.settings.bodyRestitution);
      const collider = this.world.createCollider(clDesc, rb);
      this.colliderToIndex.set(collider.handle, i);

      rb.userData = {
        index: i,
        initPos: { x, y, z: 0 },
        initRot: { x: 0, y: 0, z: 0, w: 1 },
        depthScale,
        noiseOffset: noiseOffset,
      };
      this.rigidBodies.push(rb);

      this.cachedReverseData.push({
        rb: rb,
        startPos: new THREE.Vector3(),
        startRot: new THREE.Quaternion(),
        endPos: new THREE.Vector3(x, y, 0),
        endRot: new THREE.Quaternion(0, 0, 0, 1),
        delay: i / this.gridInfo.count,
      });

      this.updateTextureData(i, { x, y, z: 0 }, { x: 0, y: 0, z: 0, w: 1 });
    }

    this.mesh.geometry.setAttribute("aRandomDepth", new THREE.InstancedBufferAttribute(randomDepths, 1));
    this.posTexture.needsUpdate = true;
    this.quatTexture.needsUpdate = true;
    if (this.tslUniforms && this.tslUniforms.uVoxelateProgress) this.tslUniforms.uVoxelateProgress.value = 0.0;
  }

  clearPhysicsBodies () {
    if (this.joint) {
      try { this.world.removeImpulseJoint(this.joint, false); } catch (e) {}
      this.joint = null;
    }
    this.activeRigidBody = null;
    this.rigidBodies.forEach((rb) => {
      if (this.world.getRigidBody(rb.handle)) this.world.removeRigidBody(rb);
    });
    this.rigidBodies = [];
    this.cachedReverseData = [];
    if (this.colliderToIndex) this.colliderToIndex.clear();
  }

  // ==========================================================================
  // PHYSICS & ANIMATION
  // ==========================================================================

  animate () {
    requestAnimationFrame(this.animate);

    if (this.state !== STATES.REVERSING && this.world) {
      try { this.world.step(); } catch (e) {}
    }
    if (this.controls) this.controls.update();

    if (this.state === STATES.ANIMATING && this.mesh) {
      this.checkAndDropBlocks();
    }

    if (this.mesh && this.state !== STATES.DEFAULT && this.posTexture && this.quatTexture) {
      for (let i = 0; i < this.rigidBodies.length; i++) {
        const rb = this.rigidBodies[ i ];
        try {
          const t = rb.translation();
          const r = rb.rotation();
          this.updateTextureData(rb.userData.index, t, r);
        } catch (e) {}
      }
      if (this.posTexture) this.posTexture.needsUpdate = true;
      if (this.quatTexture) this.quatTexture.needsUpdate = true;
    }

    if (this.renderer && this.scene && this.camera) {
      try { this.renderer.render(this.scene, this.camera); } catch (e) {}
    }
  }

  checkAndDropBlocks () {
    if (!this.tslUniforms || !this.tslUniforms.uVoxelateProgress) return;
    const currentProgress = this.tslUniforms.uVoxelateProgress.value;
    if (currentProgress < 0.01) return;

    const rippleCenter = this.tslUniforms.uRippleCenter.value;
    const { cols, rows } = this.gridInfo;
    const aspectVecX = cols / rows;
    const spread = this.params.effectSpread;

    for (let j = this.pendingDropIndices.length - 1; j >= 0; j--) {
      const i = this.pendingDropIndices[ j ];
      const col = i % cols;
      const row = Math.floor(i / cols);
      const u = (col + 0.5) / cols;
      const v = (row + 0.5) / rows;
      const dx = (u - rippleCenter.x) * aspectVecX;
      const dy = v - rippleCenter.y;
      const dist = Math.sqrt(dx * dx + dy * dy);

      const rb = this.rigidBodies[ i ];
      const { noiseOffset } = rb.userData;
      const adjustedDist = Math.max(0.0, dist + noiseOffset);

      if (currentProgress > adjustedDist + spread * 0.98) {
        this.activateBody(i);
        this.pendingDropIndices.splice(j, 1);
      }
    }
  }

  activateBody (index) {
    const rb = this.rigidBodies[ index ];
    if (!rb) return;
    rb.setBodyType(RAPIER.RigidBodyType.Dynamic);
    rb.setGravityScale(this.params.dropDelay > 0 ? 0.01 : 1.0);
    rb.setLinearDamping(this.params.dropDelay > 0 ? 1.2 : this.settings.bodyDamping);
    rb.setAngularDamping(this.params.dropDelay > 0 ? 1.2 : this.settings.bodyDamping);
    rb.wakeUp();
    const force = this.gridInfo.spacing * 2.0;
    rb.setLinvel({ x: (Math.random() - 0.5) * force, y: (Math.random() - 0.5) * force, z: (Math.random() - 0.5) * force }, true);
    rb.setAngvel({ x: Math.random() - 0.5, y: Math.random() - 0.5, z: Math.random() - 0.5 }, true);
    if (this.params.dropDelay > 0) {
      setTimeout(() => {
        try {
          if (this.world.getRigidBody(rb.handle)) {
            rb.setGravityScale(1.0);
            rb.setLinearDamping(this.settings.bodyDamping);
            rb.setAngularDamping(this.settings.bodyDamping);
            rb.wakeUp();
          }
        } catch (e) {}
      }, this.params.dropDelay * 1000);
    }
  }

  // ==========================================================================
  // STATE & SEQUENCING
  // ==========================================================================

  changeState (newState) {
    this.state = newState;
    this.refreshUIState();
  }

  handleMainAction () {
    if (this.state === STATES.COLLAPSED) {
      this.startReverseSequence();
    } else if (this.state === STATES.DEFAULT && !this.params.manualMode) {
      const u = Math.random();
      const v = Math.random();
      this.startCollapseSequence(u, v);
    }
  }

  startCollapseSequence (u, v) {
    if (this.state !== STATES.DEFAULT) return;
    gsap.killTweensOf(this.tslUniforms.uVoxelateProgress);
    this.pendingDropIndices = Array.from({ length: this.gridInfo.count }, (_, i) => i);
    if (this.tslUniforms && this.tslUniforms.uVoxelateProgress) this.tslUniforms.uVoxelateProgress.value = 0.0;

    this.changeState(STATES.ANIMATING);
    this.tslUniforms.uRippleCenter.value.set(u, v);

    const aspect = this.gridInfo.cols / this.gridInfo.rows;
    const centerX = u * aspect;
    const centerY = v;
    const corners = [
      { x: 0, y: 0 },
      { x: aspect, y: 0 },
      { x: 0, y: 1 },
      { x: aspect, y: 1 },
    ];
    const maxDist = Math.max(...corners.map((c) => Math.hypot(c.x - centerX, c.y - centerY)));
    const targetVal = maxDist + this.params.effectSpread + 0.1;

    const duration = this.params.baseDuration * targetVal;
    gsap.to(this.tslUniforms.uVoxelateProgress, {
      value: targetVal,
      duration: duration,
      ease: "none",
      onComplete: () => this.changeState(STATES.COLLAPSED),
    });
  }



  startReverseSequence () {
    if (this.state !== STATES.COLLAPSED) return;
    this.changeState(STATES.REVERSING);
    if (this.joint) {
      try { this.world.removeImpulseJoint(this.joint, false); } catch (e) {}
      this.joint = null;
      this.activeRigidBody = null;
      this.controls.enabled = true;
    }

    this.world.gravity = { x: 0, y: 0, z: 0 };

    this.cachedReverseData.forEach((data) => {
      const pos = data.rb.translation();
      const rot = data.rb.rotation();
      data.startPos.set(pos.x, pos.y, pos.z);
      data.startRot.set(rot.x, rot.y, rot.z, rot.w);
      try {
        data.rb.setBodyType(RAPIER.RigidBodyType.Fixed);
        data.rb.sleep();
      } catch (e) {}
    });

    const qTmp = new THREE.Quaternion();
    const progressObj = { value: 0 };
    const staggerStrength = 2.0;

    gsap.killTweensOf(progressObj);
    gsap.killTweensOf(this.tslUniforms.uVoxelateProgress);

    gsap.to(progressObj, {
      value: 1 + staggerStrength,
      duration: 1,
      ease: "power2.inOut",
      onUpdate: () => {
        const globalT = progressObj.value;
        for (let i = 0; i < this.cachedReverseData.length; i++) {
          const data = this.cachedReverseData[ i ];
          let t = globalT - data.delay * staggerStrength;
          t = Math.max(0, Math.min(1, t));
          if (t <= 0) continue;
          if (t >= 1 && globalT < 1) continue;
          const x = data.startPos.x + (data.endPos.x - data.startPos.x) * t;
          const y = data.startPos.y + (data.endPos.y - data.startPos.y) * t;
          const z = data.startPos.z + (data.endPos.z - data.startPos.z) * t;
          qTmp.copy(data.startRot).slerp(data.endRot, t);
          try {
            data.rb.setTranslation({ x, y, z }, true);
            data.rb.setRotation({ x: qTmp.x, y: qTmp.y, z: qTmp.z, w: qTmp.w }, true);
          } catch (e) {}
        }
      },
      onComplete: () => {
        try {
          if (this.tslUniforms && this.tslUniforms.uVoxelateProgress) this.tslUniforms.uVoxelateProgress.value = 0.0;
        } catch (e) {}

        this.clearPhysicsBodies();
        this.world.gravity = { x: 0, y: this.settings.gravityY, z: 0 };
        this.createGridBodies();
        this.pendingDropIndices = Array.from({ length: this.gridInfo.count }, (_, i) => i);
        try { this.world.step(); } catch (e) {}
        this.changeState(STATES.DEFAULT);
      },
    });
  }

  // ==========================================================================
  // INTERACTIONS
  // ==========================================================================

  onPointerDown (event) {
    if (!this.mesh) return;
    this.updatePointer(event);
    this.raycaster.setFromCamera(this.pointer, this.camera);

    if (this.state === STATES.DEFAULT && this.params.manualMode) {
      const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
      const intersectPt = new THREE.Vector3();
      const hit = this.raycaster.ray.intersectPlane(plane, intersectPt);
      if (!hit) return;

      const { width, height, spacing, cols, rows } = this.gridInfo;
      const halfW = width * 0.5;
      const halfH = height * 0.5;

      const minX = -halfW;
      const maxX = halfW;
      const minY = this.settings.gridOffsetY - halfH;
      const maxY = this.settings.gridOffsetY + halfH;

      if (intersectPt.x < minX || intersectPt.x > maxX || intersectPt.y < minY || intersectPt.y > maxY) {
        return;
      }

      const startX = -width * 0.5 + spacing * 0.5;
      const startY = -height * 0.5 + spacing * 0.5 + this.settings.gridOffsetY;

      const col = Math.floor((intersectPt.x - startX) / spacing + 0.5);
      const row = Math.floor((intersectPt.y - startY) / spacing + 0.5);

      if (col < 0 || col >= cols || row < 0 || row >= rows) return;

      const u = (col + 0.5) / cols;
      const v = (row + 0.5) / rows;

      this.startCollapseSequence(u, v);
      return;
    }

    if (this.state === STATES.COLLAPSED) {
      const rayOrigin = this.raycaster.ray.origin;
      const rayDir = this.raycaster.ray.direction;
      const rapierRay = new RAPIER.Ray(
        { x: rayOrigin.x, y: rayOrigin.y, z: rayOrigin.z },
        { x: rayDir.x, y: rayDir.y, z: rayDir.z }
      );
      const maxToi = 1000.0;
      const rawHit = this.world.castRayAndGetNormal ?
        this.world.castRayAndGetNormal(rapierRay, maxToi, true) :
        this.world.castRay(rapierRay, maxToi, true);

      if (!rawHit) return;

      let collider = null;
      const h = rawHit.collider;
      if (typeof h === 'number' || typeof h === 'bigint') {
        collider = this.world.getCollider(h);
      } else if (h && h.handle !== undefined) {
        collider = this.world.getCollider(h.handle);
      } else {
        collider = h;
      }
      if (!collider) return;
      if (this.groundCollider && collider.handle === this.groundCollider.handle) return;

      const parent = collider.parent();
      const rb = parent && parent.handle !== undefined && !parent.translation ? this.world.getRigidBody(parent.handle) : parent;
      if (!rb) return;

      const idx = this.colliderToIndex.get(collider.handle);
      if (idx === undefined) return;

      const toi = rawHit.timeOfImpact ?? rawHit.toi ?? 0;
      if (!isFinite(toi)) return;
      const hitPoint = rapierRay.pointAt(toi);
      const hitVec3 = new THREE.Vector3(hitPoint.x, hitPoint.y, hitPoint.z);
      this.startPhysicsDrag(idx, hitVec3);
    }
  }

  startPhysicsDrag (instanceId, hitPoint) {
    this.activeRigidBody = this.rigidBodies[ instanceId ];
    if (!this.activeRigidBody || this.activeRigidBody.bodyType() !== RAPIER.RigidBodyType.Dynamic) return;

    this.controls.enabled = false;
    this.distanceToCamera = this.camera.position.distanceTo(hitPoint);
    this.mouseBody.setNextKinematicTranslation({
      x: hitPoint.x,
      y: hitPoint.y,
      z: hitPoint.z
    });

    const bodyPos = this.activeRigidBody.translation();
    const bodyRot = this.activeRigidBody.rotation();
    const vecPoint = new THREE.Vector3(hitPoint.x, hitPoint.y, hitPoint.z);
    const vecBody = new THREE.Vector3(bodyPos.x, bodyPos.y, bodyPos.z);
    const quatBody = new THREE.Quaternion(bodyRot.x, bodyRot.y, bodyRot.z, bodyRot.w);

    const localAnchor = vecPoint.sub(vecBody).applyQuaternion(quatBody.clone().invert());

    this.joint = this.world.createImpulseJoint(
      RAPIER.JointData.spherical({ x: localAnchor.x, y: localAnchor.y, z: localAnchor.z }, { x: 0, y: 0, z: 0 }),
      this.activeRigidBody,
      this.mouseBody,
      true
    );
    this.activeRigidBody.wakeUp();
  }

  onPointerMove (event) {
    if (!this.joint) return;
    this.updatePointer(event);
    this.raycaster.setFromCamera(this.pointer, this.camera);

    const targetPos = this.raycaster.ray.at(this.distanceToCamera, this.intersectionPoint);
    this.mouseBody.setNextKinematicTranslation({
      x: targetPos.x,
      y: targetPos.y,
      z: targetPos.z
    });
    if (this.activeRigidBody) this.activeRigidBody.wakeUp();
  }


  onPointerUp () {
    if (this.joint) {
      if (this.activeRigidBody) this.activeRigidBody.wakeUp();
      if (this.mouseBody) this.mouseBody.wakeUp();

      this.world.removeImpulseJoint(this.joint, false);

      this.joint = null;
      this.activeRigidBody = null;
    }
    this.controls.enabled = true;
  }

  updatePointer (event) {
    this.pointer.x = (event.clientX / window.innerWidth) * 2 - 1;
    this.pointer.y = -(event.clientY / window.innerHeight) * 2 + 1;
  }

  // ==========================================================================
  // HELPERS / UTILS
  // ==========================================================================

  updateTextureData (index, pos, rot) {
    const idx = index * 4;
    // Position (XYZ, 1.0)
    this.posData[ idx ] = pos.x;
    this.posData[ idx + 1 ] = pos.y;
    this.posData[ idx + 2 ] = pos.z;
    this.posData[ idx + 3 ] = 1.0;

    // Quaternion (XYZW)
    this.quatData[ idx ] = rot.x;
    this.quatData[ idx + 1 ] = rot.y;
    this.quatData[ idx + 2 ] = rot.z;
    this.quatData[ idx + 3 ] = rot.w;
  }

  updateUniform (key, value) {
    const mappedKey = key === 'uElasticMode' ? 'uOrganicMode' : key;
    const keysToUpdate = [ mappedKey ];
    if (key === 'uElasticMode') keysToUpdate.push('uElasticMode');
    if (key === 'uOrganicMode') keysToUpdate.push('uElasticMode');

    for (const k of keysToUpdate) {
      if (this.tslUniforms && this.tslUniforms[ k ]) {
        const u = this.tslUniforms[ k ];
        if (u.value !== undefined) {
          if (u.value.set) {
            if (value && value.isColor) u.value.copy(value);
            else if (value && value.isVector2) u.value.copy(value);
            else if (typeof value === 'number' && u.value.setScalar) u.value.set(value);
            else u.value = value;
          } else {
            u.value = value;
          }
        }
      }
    }
    if (this.mesh && this.mesh.material && this.mesh.material.uniforms && this.mesh.material.uniforms[ key ]) {
      this.mesh.material.uniforms[ key ].value = value;
    }
  }

  updatePhysicsParameters () {
    const { dancingLevel, isDancing } = this.params;
    const levelNorm = dancingLevel / 10.0;

    this.settings.bodyRestitution = isDancing ? 1.0 + 0.6 * levelNorm : 0.01;
    this.settings.bodyDamping = isDancing ? 0.8 : 2.0;

    this.rigidBodies.forEach((rb) => {
      rb.setLinearDamping(this.settings.bodyDamping);
      rb.setAngularDamping(this.settings.bodyDamping);
      const collider = rb.collider(0);
      if (collider) collider.setRestitution(this.settings.bodyRestitution);
      rb.wakeUp();
    });
  }

  _computeNoiseOffset (index) {
    const glslRandom = (x, y) => {
      const dot = x * 12.9898 + y * 78.233;
      const sin = Math.sin(dot);
      const val = sin * 43758.5453123;
      return val - Math.floor(val);
    };
    const instanceNoise = glslRandom(index, 123.456);
    return (instanceNoise - 0.5) * 0.2;
  }

  adjustCameraPosition () {
    const vFovRad = THREE.MathUtils.degToRad(this.camera.fov);
    const distForWidth = this.gridInfo.width / this.camera.aspect / (2 * Math.tan(vFovRad / 2));
    const distForHeight = this.gridInfo.height / (2 * Math.tan(vFovRad / 2));

    const baseOffset = Math.max(distForWidth, distForHeight) / this.settings.fitMargin;

    const targetY = this.settings.gridOffsetY;
    const targetZ = baseOffset;

    this.camera.position.set(0, targetY, targetZ);
    this.camera.lookAt(0, targetY, 0);
    this.controls.target.set(0, targetY, 0);
    this.controls.update();
  }

  fadeoutLoadingScreen () {
    const overlay = document.querySelector("#loading-overlay");
    if (overlay) {
      gsap.to(overlay, {
        autoAlpha: 0,
        duration: 1.2,
        ease: "power4.inOut",
        onStart: () => this.video.play(),
        onComplete: () => (overlay.style.display = "none"),
      });
    }
  }

  refreshUIState () {
    if (!this.actionButton) return;
    const { state } = this;
    const { manualMode } = this.params;
    const isDefault = state === STATES.DEFAULT;
    const isCollapsed = state === STATES.COLLAPSED;

    this.debugFolders.grid.disabled = !isDefault;
    this.debugFolders.visual.disabled = !isDefault;
    this.debugFolders.controls.disabled = !isDefault;
    this.debugFolders.physics.disabled = !(isDefault || isCollapsed);

    const getConfig = BUTTON_STATES[ state ] || BUTTON_STATES[ STATES.LOADING ];
    const { title, disabled } = getConfig(manualMode);
    this.actionButton.title = title;
    this.actionButton.disabled = disabled;
  }

  onWindowResize () {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.rebuildWorld();
  }
}

window.addEventListener("load", () => new PixelVoxelDrop());
