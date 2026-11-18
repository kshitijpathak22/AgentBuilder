import React, { Suspense, useCallback, useEffect, useMemo, useRef } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { Bounds, Environment, useAnimations, useGLTF } from '@react-three/drei';
import * as THREE from 'three';
import { clone as cloneSkeleton } from 'three/examples/jsm/utils/SkeletonUtils.js';

const DEFAULT_MODEL_PATH = '/models/avatar.glb';
const BASE_LOOK_DOWN = 0.30;
const BASE_LOOK_RIGHT = 0.5;

const clamp01 = (value) => Math.min(1, Math.max(0, value));

const pickIdleClip = (clips) => {
  if (!Array.isArray(clips) || clips.length === 0) {
    return null;
  }

  const idleByName = clips.find((clip) => /idle|breath|talk|pose/i.test(clip.name || ''));
  return idleByName || clips[0];
};

const AvatarRig = ({
  modelPath,
  audioStream,
  debugMode,
  diagnosticForceJawOpen,
}) => {
  const groupRef = useRef(null);
  const meshesRef = useRef([]);
  const headBoneRef = useRef(null);
  const chestBoneRef = useRef(null);
  const analyserRef = useRef(null);
  const audioContextRef = useRef(null);
  const sourceNodeRef = useRef(null);
  const freqDataRef = useRef(null);
  const timeDataRef = useRef(null);
  const smoothVolumeRef = useRef(0);
  const blinkStateRef = useRef({ timer: 0, duration: 0.12, cooldown: 2.2, active: false });
  const debugTickRef = useRef(0);

  const gltf = useGLTF(modelPath);

  const clonedScene = useMemo(() => {
    if (!gltf?.scene) {
      return null;
    }
    return cloneSkeleton(gltf.scene);
  }, [gltf]);

  const { actions, mixer } = useAnimations(gltf?.animations || [], groupRef);

  const debugLog = useCallback(
    (...args) => {
      if (debugMode) {
        console.log('[Avatar3D]', ...args);
      }
    },
    [debugMode]
  );

  const setMorph = useCallback((name, value, smoothing = 0.22) => {
    const target = clamp01(value);

    meshesRef.current.forEach((mesh) => {
      const dictionary = mesh.morphTargetDictionary;
      const influences = mesh.morphTargetInfluences;
      if (!dictionary || !influences) {
        return;
      }

      const index = dictionary[name];
      if (typeof index !== 'number') {
        return;
      }

      const current = influences[index] || 0;
      influences[index] = THREE.MathUtils.lerp(current, target, smoothing);

      if (debugMode && debugTickRef.current % 60 === 0) {
        console.log('[Avatar3D] Morph update', { mesh: mesh.name, name, index, current, target, next: influences[index] });
      }
    });
  }, [debugMode]);

  useEffect(() => {
    if (!clonedScene) {
      return;
    }

    const meshNames = [];
    const skinnedMeshNames = [];
    const morphMeshes = [];
    const skeletonInfo = [];

    meshesRef.current = [];
    headBoneRef.current = null;
    chestBoneRef.current = null;

    clonedScene.traverse((node) => {
      if (node.isMesh) {
        meshNames.push(node.name);
      }

      if (node.isSkinnedMesh) {
        skinnedMeshNames.push(node.name);

        if (node.skeleton?.bones?.length) {
          skeletonInfo.push({ mesh: node.name, boneCount: node.skeleton.bones.length });
        }
      }

      if (node.morphTargetDictionary && node.morphTargetInfluences) {
        const morphNames = Object.keys(node.morphTargetDictionary);
        meshesRef.current.push(node);
        morphMeshes.push({ mesh: node.name, morphNames });
      }

      if (!headBoneRef.current && node.isBone && /head|neck/i.test(node.name || '')) {
        headBoneRef.current = node;
      }

      if (!chestBoneRef.current && node.isBone && /spine|chest|upperchest/i.test(node.name || '')) {
        chestBoneRef.current = node;
      }
    });

    debugLog('GLTF animations', (gltf?.animations || []).map((clip) => ({ name: clip.name, duration: clip.duration })));
    debugLog('Mesh names', meshNames);
    debugLog('Skinned mesh names', skinnedMeshNames);
    debugLog('Skeleton bone counts', skeletonInfo);
    debugLog('Morph target dictionaries', morphMeshes);
    debugLog('meshesRef.current contents', meshesRef.current.map((mesh) => mesh.name));

    if (diagnosticForceJawOpen) {
      meshesRef.current.forEach((mesh) => {
        const dictionary = mesh.morphTargetDictionary;
        if (!dictionary || typeof dictionary.jawOpen !== 'number') {
          return;
        }
        const index = dictionary.jawOpen;
        mesh.morphTargetInfluences[index] = 1;
        debugLog('Diagnostic jaw open applied', { mesh: mesh.name, index });
      });
    }
  }, [clonedScene, debugLog, diagnosticForceJawOpen, gltf]);

  useEffect(() => {
    if (!groupRef.current || !gltf?.animations?.length) {
      return;
    }

    const idleClip = pickIdleClip(gltf.animations);
    if (!idleClip) {
      debugLog('No animation clips found for playback');
      return;
    }

    const idleAction = actions[idleClip.name];
    if (!idleAction) {
      debugLog('Idle clip exists but no action was created', idleClip.name);
      return;
    }

    idleAction.reset().setLoop(THREE.LoopRepeat, Infinity).fadeIn(0.2).play();
    debugLog('Playing idle animation clip', idleClip.name);

    return () => {
      idleAction.fadeOut(0.2);
    };
  }, [actions, debugLog, gltf]);

  useEffect(() => {
    if (!audioStream) {
      debugLog('audioStream status', 'No audio stream received');
      if (sourceNodeRef.current) {
        sourceNodeRef.current.disconnect();
        sourceNodeRef.current = null;
      }
      analyserRef.current = null;
      freqDataRef.current = null;
      timeDataRef.current = null;
      return;
    }

    if (!audioStream.getAudioTracks().length) {
      debugLog('audioStream status', 'Stream exists but has no audio tracks');
      return;
    }

    let cancelled = false;
    let createdContext = false;

    const setupAnalyser = async () => {
      try {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (!AudioCtx) {
          debugLog('analyser status', 'AudioContext not supported in browser');
          return;
        }

        if (!audioContextRef.current) {
          audioContextRef.current = new AudioCtx();
          createdContext = true;
        }

        if (audioContextRef.current.state === 'suspended') {
          await audioContextRef.current.resume();
        }

        if (cancelled) {
          return;
        }

        if (sourceNodeRef.current) {
          sourceNodeRef.current.disconnect();
          sourceNodeRef.current = null;
        }

        const sourceNode = audioContextRef.current.createMediaStreamSource(audioStream);
        const analyser = audioContextRef.current.createAnalyser();
        analyser.fftSize = 1024;
        analyser.smoothingTimeConstant = 0.75;
        sourceNode.connect(analyser);

        sourceNodeRef.current = sourceNode;
        analyserRef.current = analyser;
        freqDataRef.current = new Uint8Array(analyser.frequencyBinCount);
        timeDataRef.current = new Uint8Array(analyser.fftSize);

        debugLog('audioStream status', {
          active: audioStream.active,
          trackStates: audioStream.getAudioTracks().map((track) => ({
            id: track.id,
            enabled: track.enabled,
            muted: track.muted,
            readyState: track.readyState,
          })),
        });
        debugLog('analyser status', { fftSize: analyser.fftSize, bins: analyser.frequencyBinCount });
      } catch (error) {
        debugLog('Failed to initialize analyser', error);
      }
    };

    setupAnalyser();

    return () => {
      cancelled = true;
      if (sourceNodeRef.current) {
        sourceNodeRef.current.disconnect();
        sourceNodeRef.current = null;
      }
      analyserRef.current = null;
      freqDataRef.current = null;
      timeDataRef.current = null;

      if (createdContext && audioContextRef.current) {
        audioContextRef.current.close().catch(() => undefined);
        audioContextRef.current = null;
      }
    };
  }, [audioStream, debugLog]);

  useFrame((state, delta) => {
    debugTickRef.current += 1;

    if (mixer) {
      mixer.update(delta);
    }

    const analyser = analyserRef.current;
    const freqData = freqDataRef.current;
    const timeData = timeDataRef.current;

    let volume = 0;
    if (analyser && freqData && timeData) {
      analyser.getByteFrequencyData(freqData);
      analyser.getByteTimeDomainData(timeData);

      let sumSquares = 0;
      for (let i = 0; i < timeData.length; i += 1) {
        const sample = (timeData[i] - 128) / 128;
        sumSquares += sample * sample;
      }

      const rms = Math.sqrt(sumSquares / timeData.length);
      volume = clamp01((rms - 0.01) * 5.5);
      smoothVolumeRef.current = THREE.MathUtils.lerp(smoothVolumeRef.current, volume, 0.28);

      if (debugMode && debugTickRef.current % 60 === 0) {
        const freqPreview = Array.from(freqData.slice(0, 12));
        console.log('[Avatar3D] analyser frequency values', freqPreview);
        console.log('[Avatar3D] volume values', { raw: volume, smooth: smoothVolumeRef.current });
      }
    } else {
      smoothVolumeRef.current = THREE.MathUtils.lerp(smoothVolumeRef.current, 0, 0.15);
    }

    const speaking = smoothVolumeRef.current;
    if (!diagnosticForceJawOpen) {
      setMorph('jawOpen', speaking, 0.35);
    }
    setMorph('mouthOpen', speaking * 0.65, 0.25);
    setMorph('viseme_sil', clamp01(1 - speaking * 1.3), 0.2);
    setMorph('viseme_aa', speaking * 0.9, 0.3);
    setMorph('viseme_O', Math.max(0, speaking - 0.35), 0.25);
    setMorph('viseme_U', Math.max(0, speaking - 0.58), 0.22);
    setMorph('viseme_E', speaking * 0.45, 0.2);

    const blink = blinkStateRef.current;
    blink.timer += delta;
    if (!blink.active && blink.timer >= blink.cooldown) {
      blink.active = true;
      blink.timer = 0;
      blink.duration = 0.08 + Math.random() * 0.07;
      blink.cooldown = 1.8 + Math.random() * 2.6;
    }

    let blinkValue = 0;
    if (blink.active) {
      const t = clamp01(blink.timer / blink.duration);
      blinkValue = t < 0.5 ? t * 2 : (1 - t) * 2;
      if (t >= 1) {
        blink.active = false;
        blink.timer = 0;
      }
    }
    setMorph('eyeBlinkLeft', blinkValue, 0.65);
    setMorph('eyeBlinkRight', blinkValue, 0.65);

    const elapsed = state.clock.getElapsedTime();

    if (headBoneRef.current) {
      headBoneRef.current.rotation.y = BASE_LOOK_RIGHT + Math.sin(elapsed * 0.35) * 0.08;
      headBoneRef.current.rotation.x = BASE_LOOK_DOWN + Math.sin(elapsed * 0.55) * 0.03;
    }

    if (chestBoneRef.current) {
      chestBoneRef.current.position.y = Math.sin(elapsed * 1.4) * 0.004;
      chestBoneRef.current.rotation.x = Math.sin(elapsed * 0.9) * 0.01;
    }
  });

  if (!clonedScene) {
    return null;
  }

  return (
  <primitive 
  ref={groupRef} 
  object={clonedScene}
  position={[0, -2.3, 0]}
  scale={1.5}
  />
);
};

const Avatar3D = ({
  width = '100%',
  height = '280px',
  className = '',
  audioStream = null,
  debugMode = false,
  diagnosticForceJawOpen = false,
  modelPath = DEFAULT_MODEL_PATH,
}) => {
  return (
    <div 
    className={`avatar3d-container ${className}`} 
    style={{
      width,
      height,
      backgroundImage: "url('/background/office.jpg')",
      backgroundSize: "cover",
      backgroundPosition: "center",
      backgroundRepeat: "no-repeat",
      borderRadius: "12px",
      overflow: "hidden"
    }}>
      <Canvas className="avatar3d-canvas" 
      gl={{alpha: true}}
      camera={{ position: [-3.9, 5.0, 15], fov: 3.5   }}>
        {/* <color attach="background" args={['#0f172a']} /> */}
        <ambientLight intensity={0.55} />
        <directionalLight position={[2, 3, 2]} intensity={0.85} />
        <directionalLight position={[-2, 2, -2]} intensity={0.6} />
        <Suspense fallback={null}>
          <Bounds fit={false}>
            <AvatarRig
              modelPath={modelPath}
              audioStream={audioStream}
              debugMode={debugMode}
              diagnosticForceJawOpen={diagnosticForceJawOpen}
            />
          </Bounds>
          {/*<Environment preset="studio" /> */}
        </Suspense>
      </Canvas>
    </div>
  );
};

useGLTF.preload(DEFAULT_MODEL_PATH);

export default Avatar3D;
