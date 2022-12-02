// eslint-disable-next-line @typescript-eslint/triple-slash-reference
/// <reference path="../../types/globals.d.ts" />

import VertexHasher from './mesh-gen/VertexHasher';
import { DynamicArray } from './mesh-gen/DynamicArray';
import { EPS } from './misc/EPS';
import { mat3, mat4, vec3, vec4 } from 'gl-matrix';

import type { StrippedMesh } from '../common/StrippedMesh';
import type { quat } from 'gl-matrix';

const MAX_INDEX = 0xFFFFFFFF;

/**
 * Maps a manifold triangle index to a WLE submesh index. The format is:
 * [0]: submesh index of manifold triangle 0
 * [1]: triangle index of manifold triangle 0
 * [2]: submesh index of manifold triangle 1
 * [3]: triangle index of manifold triangle 1
 * ...
 * [2n]: submesh index of manifold triangle n
 * [2n + 1]: triangle index of manifold triangle n
 */
export type SubmeshMap = Uint8Array | Uint16Array | Uint32Array;

export type Submesh = [mesh: WL.Mesh, material: WL.Material];

export abstract class BaseManifoldWLMesh {
    /**
     * If this flag is set, then {@link dispose} will be called after a CSG
     * operation is done. It's recommended to call {@link mark} instead of
     * setting this manually, since the method is chainable.
     */
    autoDispose = false;

    /**
     * WARNING: the submeshes array and the manifold mesh will have their
     * ownership tranferred to this object. if you modify them later, they will
     * be modified here as well, possibly corrupting the mesh. to avoid issues
     * with this, do a deep clone of the inputs
     */
    constructor(protected submeshes: Array<Submesh> = [], protected premadeManifoldMesh: StrippedMesh | null = null, protected submeshMap: SubmeshMap | null = null) {}

    get manifoldMesh(): StrippedMesh {
        if (!this.premadeManifoldMesh) {
            const wleMeshes = new Array<WL.Mesh>(this.submeshes.length);

            let i = 0;
            for (const [wleMesh, _material] of this.submeshes) {
                wleMeshes[i++] = wleMesh;
            }

            [this.submeshMap, this.premadeManifoldMesh] = BaseManifoldWLMesh.manifoldFromWLE(wleMeshes);
        }

        return this.premadeManifoldMesh;
    }

    get submeshCount(): number {
        return this.submeshes.length;
    }

    getSubmesh(submeshIdx: number): Submesh {
        const submesh = this.submeshes[submeshIdx];

        if (!submesh) {
            throw new Error(`No submesh exists at index ${submeshIdx}`);
        }

        return submesh;
    }

    getSubmeshes(): Array<Submesh> {
        const submeshes = new Array(this.submeshCount);

        for (let i = 0; i < this.submeshCount; i++) {
            const submesh = this.submeshes[i];
            submeshes[i] = [submesh[0], submesh[1]];
        }

        return submeshes;
    }

    getTriBarySubmesh(triIdx: number): [submesh: Submesh, iTriOrig: number] {
        if (!this.submeshMap) {
            throw new Error('Missing submesh map');
        }

        const offset = triIdx * 2;
        return [
            this.getSubmesh(this.submeshMap[offset]),
            this.submeshMap[offset + 1]
        ];
    }

    static manifoldFromWLE(wleMeshes: WL.Mesh | Array<WL.Mesh>): [submeshMap: SubmeshMap, manifoldMesh: StrippedMesh];
    static manifoldFromWLE(wleMeshes: WL.Mesh | Array<WL.Mesh>, genSubmeshMap: true): [submeshMap: SubmeshMap, manifoldMesh: StrippedMesh];
    static manifoldFromWLE(wleMeshes: WL.Mesh | Array<WL.Mesh>, genSubmeshMap: false): StrippedMesh;
    static manifoldFromWLE(wleMeshes: WL.Mesh | Array<WL.Mesh>, genSubmeshMap = true): StrippedMesh | [submeshMap: SubmeshMap, manifoldMesh: StrippedMesh] {
        if (!Array.isArray(wleMeshes)) {
            wleMeshes = [wleMeshes];
        }

        // try to make manifold from mesh. this will fail if there are
        // disconnected faces that have edges with the same position (despite
        // being different edges)
        // validate vertex count
        let totalVertexCount = 0;
        let maxSubmeshTriCount = 0;
        let indexCount = 0;

        for (const wleMesh of wleMeshes) {
            const packedVertexCount = wleMesh.vertexCount;
            const indexData = wleMesh.indexData;
            indexCount = indexData === null ? packedVertexCount : indexData.length;

            if (indexCount % 3 !== 0) {
                throw new Error(`Mesh has an invalid index count (${indexCount}). Must be a multiple of 3`);
            }

            totalVertexCount += indexCount;
            maxSubmeshTriCount = Math.max(maxSubmeshTriCount, indexCount / 3);
        }

        const triVerts = new Uint32Array(totalVertexCount);
        const vertPos = new DynamicArray(Float32Array);
        const totalTriCount = totalVertexCount / 3;
        const hasher = new VertexHasher();
        const submeshMap = genSubmeshMap ? BaseManifoldWLMesh.makeSubmeshMapBuffer(totalTriCount, maxSubmeshTriCount, wleMeshes.length - 1) : null;
        let jm = 0;
        let js = 0;

        for (let submeshIdx = 0; submeshIdx < wleMeshes.length; submeshIdx++) {
            // prepare accessors
            const wleMesh = wleMeshes[submeshIdx];
            const positions = wleMesh.attribute(WL.MeshAttribute.Position);
            const packedVertexCount = wleMesh.vertexCount;
            const indexData = wleMesh.indexData;
            const vertexCount = indexData === null ? packedVertexCount : indexData.length;

            // convert positions
            const mergedIndices = new Array<number>();
            for (let i = 0; i < packedVertexCount; i++) {
                const pos = positions.get(i);

                if (hasher.isUnique(pos)) {
                    mergedIndices.push(vertPos.length / 3);
                    const offset = vertPos.length;
                    vertPos.length += 3;
                    vertPos.copy(offset, pos);
                } else {
                    const [x, y, z] = pos;
                    let k = 0;
                    for (; k < vertPos.length; k += 3) {
                        if (Math.abs(vertPos.get(k) - x) < EPS
                             && Math.abs(vertPos.get(k + 1) - y) < EPS
                             && Math.abs(vertPos.get(k + 2) - z) < EPS) {
                            break;
                        }
                    }

                    mergedIndices.push(k / 3);

                    if (k === vertPos.length) {
                        vertPos.length += 3;
                        vertPos.copy(k, pos);
                    }
                }
            }

            // make triangles
            let tri = 0;
            if (indexData === null) {
                for (let i = 0; i < vertexCount;) {
                    triVerts[jm++] = mergedIndices[i++];
                    triVerts[jm++] = mergedIndices[i++];
                    triVerts[jm++] = mergedIndices[i++];

                    if (submeshMap) {
                        submeshMap[js++] = submeshIdx;
                        submeshMap[js++] = tri++;
                    }
                }
            } else {
                for (let i = 0; i < vertexCount;) {
                    triVerts[jm++] = mergedIndices[indexData[i++]];
                    triVerts[jm++] = mergedIndices[indexData[i++]];
                    triVerts[jm++] = mergedIndices[indexData[i++]];

                    if (submeshMap) {
                        submeshMap[js++] = submeshIdx;
                        submeshMap[js++] = tri++;
                    }
                }
            }
        }

        if (jm !== triVerts.length) {
            throw new Error('Unexpected manifold triangle count');
        }

        const mesh = <StrippedMesh>{ vertPos: vertPos.finalize(), triVerts };

        if (submeshMap) {
            if (js !== submeshMap.length) {
                throw new Error(`Unexpected iterator position for submeshMap; expected ${submeshMap.length}, got ${js}`);
            }

            return [submeshMap, mesh];
        } else {
            return mesh;
        }
    }

    static makeIndexBuffer(size: number, vertexCount: number): [indexData: Uint8Array, indexType: WL.MeshIndexType] | [indexData: Uint16Array, indexType: WL.MeshIndexType] | [indexData: Uint32Array, indexType: WL.MeshIndexType] {
        if (vertexCount <= 0xFF) {
            return [new Uint8Array(size), WL.MeshIndexType.UnsignedByte];
        } else if (vertexCount <= 0xFFFF) {
            return [new Uint16Array(size), WL.MeshIndexType.UnsignedShort];
        } else if (vertexCount <= MAX_INDEX) {
            return [new Uint32Array(size), WL.MeshIndexType.UnsignedInt];
        } else {
            throw new Error(`Maximum index exceeded (${MAX_INDEX})`);
        }
    }

    static makeSubmeshMapBuffer(triCount: number, maxSubmeshTriCount: number, maxSubmeshIdx: number): SubmeshMap {
        const maxNum = Math.max(maxSubmeshTriCount - 1, maxSubmeshIdx);
        if (maxNum <= 0xFF) {
            return new Uint8Array(triCount * 2);
        } else if (maxNum <= 0xFFFF) {
            return new Uint16Array(triCount * 2);
        } else if (maxNum <= MAX_INDEX) {
            return new Uint32Array(triCount * 2);
        } else {
            throw new Error(`Maximum index exceeded (${MAX_INDEX})`);
        }
    }

    /**
     * Destroy the Wonderland Engine meshes stored in this object. Note that if
     * the submeshes are reused elsewhere, then this will destroy those too.
     */
    dispose(): void {
        for (const [mesh, _material] of this.submeshes) {
            mesh.destroy();
        }

        this.submeshes.splice(0, this.submeshes.length);
        this.premadeManifoldMesh = null;
        this.submeshMap = null;
    }

    /**
     * Sets {@link autoDispose} to true (marks as auto-disposable). Chainable
     * method.
     */
    mark(): this {
        this.autoDispose = true;
        return this;
    }

    /**
     * Transform all submeshes and the manifold by a given matrix and normal
     * matrix.
     */
    transform(matrix: mat4, normalMatrix?: mat3): void {
        if (!normalMatrix) {
            normalMatrix = mat3.normalFromMat4(mat3.create(), matrix);
        }

        const tmp3 = vec3.create();
        const tmp4 = vec4.create();

        // transform submeshes
        for (const [submesh, _material] of this.submeshes) {
            const vertexCount = submesh.vertexCount;

            const positions = submesh.attribute(WL.MeshAttribute.Position);
            if (!positions) {
                throw new Error('Could not get positions MeshAttributeAccessor');
            }

            const normals = submesh.attribute(WL.MeshAttribute.Normal);
            const tangents = submesh.attribute(WL.MeshAttribute.Tangent);

            for (let i = 0; i < vertexCount; i++) {
                positions.get(i, tmp3)
                vec3.transformMat4(tmp3, tmp3, matrix);
                positions.set(i, tmp3);

                if (normals) {
                    normals.get(i, tmp3)
                    vec3.transformMat3(tmp3, tmp3, normalMatrix);
                    normals.set(i, tmp3);
                }

                if (tangents) {
                    tangents.get(i, tmp4)
                    vec3.transformMat3(tmp4 as vec3, tmp4 as vec3, normalMatrix);
                    tangents.set(i, tmp4);
                }
            }
        }

        // transform premade manifold
        if (this.premadeManifoldMesh) {
            const vertPos = this.premadeManifoldMesh.vertPos;
            const vertexCount = vertPos.length;

            for (let i = 0; i < vertexCount;) {
                const iStart = i;
                tmp3[0] = vertPos[i++];
                tmp3[1] = vertPos[i++];
                tmp3[2] = vertPos[i++];

                vec3.transformMat4(tmp3, tmp3, matrix);

                vertPos[iStart] = tmp3[0];
                vertPos[iStart + 1] = tmp3[1];
                vertPos[iStart + 2] = tmp3[2];
            }
        }
    }

    /**
     * Translate all submeshes and the manifold by a given translation vector.
     */
    translate(translation: vec3): void {
        this.transform(mat4.fromTranslation(mat4.create(), translation));
    }

    /** Scale all submeshes and the manifold by a given per-axis factor. */
    scale(factor: vec3): void {
        this.transform(mat4.fromScaling(mat4.create(), factor));
    }

    /** Scale all submeshes and the manifold by a single factor. */
    uniformScale(factor: number): void {
        this.transform(mat4.fromScaling(mat4.create(), vec3.fromValues(factor, factor, factor)));
    }

    /** Rotate all submeshes and the manifold by a given quaternion. */
    rotate(rotation: quat): void {
        this.transform(mat4.fromQuat(mat4.create(), rotation));
    }
}