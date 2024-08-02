import { Constants } from "../../Engines/constants";
import type { AbstractEngine } from "../../Engines/abstractEngine";
import type { Scene } from "../../scene";
import { Matrix, Vector2, Vector4 } from "../../Maths/math.vector";
import "../../Shaders/iblShadowVoxelTracing.fragment";
import "../../Shaders/iblShadowDebug.fragment";
import { PostProcess } from "../../PostProcesses/postProcess";
import type { PostProcessOptions } from "../../PostProcesses/postProcess";
import type { IblShadowsRenderPipeline } from "./iblShadowsRenderPipeline";
import type { Effect } from "../../Materials/effect";
import type { Camera } from "../../Cameras/camera";

/**
 * Build cdf maps for IBL importance sampling during IBL shadow computation.
 * This should not be instanciated directly, as it is part of a scene component
 * @internal
 */
export class _IblShadowsVoxelTracingPass {
    private _scene: Scene;
    private _engine: AbstractEngine;
    private _renderPipeline: IblShadowsRenderPipeline;
    private _voxelShadowOpacity: number = 1.0;
    /**
     * The opacity of the shadow cast from the voxel grid
     */
    public get voxelShadowOpacity(): number {
        return this._voxelShadowOpacity;
    }
    /**
     * The opacity of the shadow cast from the voxel grid
     */
    public set voxelShadowOpacity(value: number) {
        this._voxelShadowOpacity = value;
    }
    private _sssSamples: number = 16;
    private _sssStride: number = 8;
    private _sssMaxDist: number = 0.05;
    private _sssThickness: number = 0.01;

    private _ssShadowOpacity: number = 1.0;
    /**
     * The opacity of the screen-space shadow
     */
    public get ssShadowOpacity(): number {
        return this._ssShadowOpacity;
    }
    /**
     * The opacity of the screen-space shadow
     */
    public set ssShadowOpacity(value: number) {
        this._ssShadowOpacity = value;
    }
    public get sssSamples(): number {
        return this._sssSamples;
    }
    public set sssSamples(value: number) {
        this._sssSamples = value;
    }
    public get sssStride(): number {
        return this._sssStride;
    }
    public set sssStride(value: number) {
        this._sssStride = value;
    }
    public get sssMaxDist(): number {
        return this._sssMaxDist;
    }
    public set sssMaxDist(value: number) {
        this._sssMaxDist = value;
    }
    public get sssThickness(): number {
        return this._sssThickness;
    }
    public set sssThickness(value: number) {
        this._sssThickness = value;
    }

    private _outputPP: PostProcess;
    private _cameraInvView: Matrix = Matrix.Identity();
    private _cameraInvProj: Matrix = Matrix.Identity();
    private _invWorldScaleMatrix: Matrix = Matrix.Identity();
    private _frameId: number = 0;
    private _sampleDirections: number = 4;
    public get sampleDirections(): number {
        return this._sampleDirections;
    }
    public set sampleDirections(value: number) {
        this._sampleDirections = value;
    }
    public get envRotation(): number {
        return this._envRotation;
    }
    public set envRotation(value: number) {
        this._envRotation = value;
    }

    /** Enable the debug view for this pass */
    public debugEnabled: boolean = false;

    /**
     * Gets the pass post process
     * @returns The post process
     */
    public getPassPP(): PostProcess {
        return this._outputPP;
    }

    /**
     * Gets the debug pass post process. This will create the resources for the pass
     * if they don't already exist.
     * @returns The post process
     */
    public getDebugPassPP(): PostProcess {
        if (!this._debugPassPP) {
            this._createDebugPass();
        }
        return this._debugPassPP;
    }

    private _debugPassName: string = "Voxel Tracing Debug Pass";
    public get debugPassName(): string {
        return this._debugPassName;
    }

    /** The default rotation of the environment map will align the shadows with the default lighting orientation */
    private _envRotation: number = -Math.PI / 2.0;
    private _downscale: number = 1.0;

    public setWorldScaleMatrix(matrix: Matrix) {
        this._invWorldScaleMatrix = matrix;
    }

    private _debugVoxelMarchEnabled: boolean = false;
    private _debugPassPP: PostProcess;
    private _debugSizeParams: Vector4 = new Vector4(0.0, 0.0, 0.0, 0.0);
    public setDebugDisplayParams(x: number, y: number, widthScale: number, heightScale: number) {
        this._debugSizeParams.set(x, y, widthScale, heightScale);
    }

    /**
     * Creates the debug post process effect for this pass
     */
    private _createDebugPass() {
        if (!this._debugPassPP) {
            const debugOptions: PostProcessOptions = {
                width: this._engine.getRenderWidth(),
                height: this._engine.getRenderHeight(),
                uniforms: ["sizeParams"],
                samplers: ["debugSampler"],
                engine: this._engine,
                reusable: false,
            };
            this._debugPassPP = new PostProcess(this.debugPassName, "iblShadowDebug", debugOptions);
            this._debugPassPP.autoClear = false;
            this._debugPassPP.onApply = (effect) => {
                // update the caustic texture with what we just rendered.
                effect.setTextureFromPostProcessOutput("debugSampler", this._outputPP);
                effect.setVector4("sizeParams", this._debugSizeParams);
            };
        }
    }

    /**
     * Instantiates the shadow voxel-tracing pass
     * @param scene Scene to attach to
     * @param iblShadowsRenderPipeline The IBL shadows render pipeline
     * @returns The shadow voxel-tracing pass
     */
    constructor(scene: Scene, iblShadowsRenderPipeline: IblShadowsRenderPipeline) {
        this._scene = scene;
        this._engine = scene.getEngine();
        this._renderPipeline = iblShadowsRenderPipeline;
        this._createTextures();
    }

    private _createTextures() {
        const voxelGrid = this._renderPipeline!.getVoxelGridTexture();
        let defines = "#define VOXEL_MARCHING_NUM_MIPS " + Math.log2(voxelGrid!.getSize().width).toFixed(0) + "u\n";
        defines += "#define VOXEL_GRID_RESOLUTION " + voxelGrid!.getSize().width.toFixed(0) + "u\n";
        if (this._debugVoxelMarchEnabled) {
            defines += "#define VOXEL_MARCH_DIAGNOSTIC_INFO_OPTION 1u\n";
        }
        const ppOptions: PostProcessOptions = {
            width: this._engine.getRenderWidth(),
            height: this._engine.getRenderHeight(),
            textureFormat: Constants.TEXTUREFORMAT_RGBA,
            textureType: Constants.TEXTURETYPE_UNSIGNED_BYTE,
            samplingMode: Constants.TEXTURE_NEAREST_SAMPLINGMODE,
            uniforms: ["viewMtx", "projMtx", "invProjMtx", "invViewMtx", "wsNormalizationMtx", "shadowParameters", "offsetDataParameters", "sssParameters", "shadowOpacity"],
            samplers: ["voxelGridSampler", "icdfySampler", "icdfxSampler", "blueNoiseSampler", "worldNormalSampler", "linearDepthSampler", "depthSampler", "worldPositionSampler"],
            defines: defines,
            engine: this._engine,
            reusable: false,
        };
        this._outputPP = new PostProcess("voxelTracingPass", "iblShadowVoxelTracing", ppOptions);
        this._outputPP.autoClear = false;
        this._outputPP.onApply = (effect) => {
            this._updatePostProcess(effect, this._scene.activeCamera!);
        };
    }

    private _updatePostProcess(effect: Effect, camera: Camera) {
        effect.setMatrix("viewMtx", camera.getViewMatrix());
        effect.setMatrix("projMtx", camera.getProjectionMatrix());
        camera.getProjectionMatrix().invertToRef(this._cameraInvProj);
        camera.getViewMatrix().invertToRef(this._cameraInvView);
        effect.setMatrix("invProjMtx", this._cameraInvProj);
        effect.setMatrix("invViewMtx", this._cameraInvView);
        effect.setMatrix("wsNormalizationMtx", this._invWorldScaleMatrix);

        this._frameId++;

        const downscaleSquared = this._downscale * this._downscale;
        const rotation = this._scene.useRightHandedSystem ? this._envRotation : (this._envRotation + Math.PI) % (2.0 * Math.PI);
        effect.setVector4("shadowParameters", new Vector4(this._sampleDirections, this._frameId / downscaleSquared, this._downscale, rotation));
        const offset = new Vector2(0.0, 0.0);
        const voxelGrid = this._renderPipeline!.getVoxelGridTexture();
        const highestMip = Math.floor(Math.log2(voxelGrid!.getSize().width));
        effect.setVector4("offsetDataParameters", new Vector4(offset.x, offset.y, highestMip, 0.0));

        // SSS Options.
        const worldScale = (1.0 / this._invWorldScaleMatrix.m[0]) * 2.0;
        const maxDist = this._sssMaxDist * worldScale;
        const thickness = this._sssThickness * worldScale;
        effect.setVector4("sssParameters", new Vector4(this._sssSamples, this._sssStride, maxDist, thickness));
        effect.setVector4("shadowOpacity", new Vector4(this._voxelShadowOpacity, this._ssShadowOpacity, 0.0, 0.0));
        effect.setTexture("voxelGridSampler", voxelGrid);
        effect.setTexture("blueNoiseSampler", (this._renderPipeline as any)._noiseTexture);
        effect.setTexture("icdfySampler", this._renderPipeline!.getIcdfyTexture());
        effect.setTexture("icdfxSampler", this._renderPipeline!.getIcdfxTexture());
        effect.defines = "#define VOXEL_MARCHING_NUM_MIPS " + Math.log2(voxelGrid!.getSize().width).toFixed(0) + "u\n";
        effect.defines += "#define VOXEL_GRID_RESOLUTION " + voxelGrid!.getSize().width.toFixed(0) + "u\n";
        if (this._debugVoxelMarchEnabled) {
            effect.defines += "#define VOXEL_MARCH_DIAGNOSTIC_INFO_OPTION 1u\n";
        }

        const prePassRenderer = this._scene.prePassRenderer;
        if (prePassRenderer) {
            const wnormalIndex = prePassRenderer.getIndex(Constants.PREPASS_WORLD_NORMAL_TEXTURE_TYPE);
            const depthIndex = prePassRenderer.getIndex(Constants.PREPASS_DEPTH_TEXTURE_TYPE);
            const clipDepthIndex = prePassRenderer.getIndex(Constants.PREPASS_CLIPSPACE_DEPTH_TEXTURE_TYPE);
            const wPositionIndex = prePassRenderer.getIndex(Constants.PREPASS_POSITION_TEXTURE_TYPE);
            if (wnormalIndex >= 0) effect.setTexture("worldNormalSampler", prePassRenderer.getRenderTarget().textures[wnormalIndex]);
            if (depthIndex >= 0) effect.setTexture("linearDepthSampler", prePassRenderer.getRenderTarget().textures[depthIndex]);
            if (clipDepthIndex >= 0) effect.setTexture("depthSampler", prePassRenderer.getRenderTarget().textures[clipDepthIndex]);
            if (wPositionIndex >= 0) effect.setTexture("worldPositionSampler", prePassRenderer.getRenderTarget().textures[wPositionIndex]);
        }
    }

    /**
     * Checks if the pass is ready
     * @returns true if the pass is ready
     */
    public isReady() {
        return this._outputPP.isReady() && !(this._debugPassPP && !this._debugPassPP.isReady());
    }

    /**
     * Disposes the associated resources
     */
    public dispose() {
        this._outputPP.dispose();
        if (this._debugPassPP) {
            this._debugPassPP.dispose();
        }
    }
}
