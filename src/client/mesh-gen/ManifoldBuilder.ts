import { DynamicArray } from './DynamicArray';
import { BitArray } from './BitArray';
import { Triangle } from './Triangle';
import { vec3, mat4 } from 'gl-matrix';
import { BaseManifoldWLMesh, Submesh, SubmeshMap } from '../BaseManifoldWLMesh';
import VertexHasher from './VertexHasher';

import type { vec2, quat } from 'gl-matrix';
import { normalFromTriangle } from './normal-from-triangle';

const MAT4_IDENTITY = mat4.create();
const TAU_INV = 1 / (Math.PI * 2);

function getMatchingEdge(a: vec3, b: vec3, oPos0: vec3, oPos1: vec3, oPos2: vec3): number | null {
    // TODO make a decision tree instead of this innefficient abomination
    if ((vec3.exactEquals(a, oPos0) && vec3.exactEquals(b, oPos1)) || (vec3.exactEquals(b, oPos0) && vec3.exactEquals(a, oPos1))) {
        return 0;
    } else if ((vec3.exactEquals(a, oPos1) && vec3.exactEquals(b, oPos2)) || (vec3.exactEquals(b, oPos1) && vec3.exactEquals(a, oPos2))) {
        return 1;
    } else if ((vec3.exactEquals(a, oPos2) && vec3.exactEquals(b, oPos0)) || (vec3.exactEquals(b, oPos2) && vec3.exactEquals(a, oPos0))) {
        return 2;
    } else {
        return null;
    }
}

function connectTriangles(ti: number, triangles: Array<Triangle>, visitedTriangles: BitArray) {
    // ignore triangle if already visited
    if (visitedTriangles.get(ti)) {
        return;
    }

    // mark this triangle as visited
    visitedTriangles.set(ti, true);

    // check which edges need connections
    const triangle = triangles[ti];
    const missingEdge0 = triangle.getConnectedEdge(0) === null;
    const missingEdge1 = triangle.getConnectedEdge(1) === null;
    const missingEdge2 = triangle.getConnectedEdge(2) === null;
    let edgesLeft = 0;

    if (missingEdge0) {
        edgesLeft++;
    }
    if (missingEdge1) {
        edgesLeft++;
    }
    if (missingEdge2) {
        edgesLeft++;
    }

    // no edges need connections, skip triangle
    if (edgesLeft === 0) {
        return;
    }

    // some edges need connecting. get positions of each vertex and try
    // connecting to unvisited triangles
    const pos0 = triangle.getPosition(0);
    const pos1 = triangle.getPosition(1);
    const pos2 = triangle.getPosition(2);

    const triCount = triangles.length;
    const visitQueue: Array<number> = [];
    const edgeHelpers: Array<[missing: boolean, a: vec3, b: vec3]> = [
        [ missingEdge0, pos0, pos1 ],
        [ missingEdge1, pos1, pos2 ],
        [ missingEdge2, pos2, pos0 ],
    ];

    for (let oti = 0; oti < triCount; oti++) {
        // ignore triangles that have already been visited
        if (visitedTriangles.get(oti)) {
            continue;
        }

        // connect if edge positions match
        const otherTriangle = triangles[oti];
        const oPos0 = otherTriangle.getPosition(0);
        const oPos1 = otherTriangle.getPosition(1);
        const oPos2 = otherTriangle.getPosition(2);

        for (let edgeIdx = 0; edgeIdx < 3; edgeIdx++) {
            const edgeHelper = edgeHelpers[edgeIdx];
            const [ missing, a, b ] = edgeHelper;
            if (!missing) {
                continue;
            }

            const match = getMatchingEdge(a, b, oPos0, oPos1, oPos2);
            if (match !== null) {
                edgeHelper[0] = false;
                otherTriangle.connectEdge(match, edgeIdx, triangle);
                visitQueue.push(oti);
                if (--edgesLeft === 0) {
                    break;
                }
            }
        }

        if (edgesLeft === 0) {
            break;
        }
    }

    // visit triangles that were connected
    for (const oti of visitQueue) {
        connectTriangles(oti, triangles, visitedTriangles);
    }
}

function getVertexMid(a: Float32Array, b: Float32Array): Float32Array {
    const result = new Float32Array(8);

    for (let i = 0; i < 8; i++) {
        result[i] = (a[i] + b[i]) * 0.5;
    }

    return result;
}

function sortMaterials(materials: Iterable<WL.Material | null>, materialMap: Map<number, WL.Material>): Array<number | null> {
    // reverse the material map (map materials to material IDs)
    const revMaterialMap = new Map<WL.Material, number>();
    for (const [id, material] of materialMap) {
        revMaterialMap.set(material, id);
    }

    // sort materials by id (and handle nulls)
    return Array.from(materials).sort((a, b) => {
        if (a === null) {
            return -1;
        } else if (b === null) {
            return 1;
        }

        const aID = revMaterialMap.get(a) as number;
        const bID = revMaterialMap.get(b) as number;

        if (aID < bID) {
            return -1;
        } else if (aID > bID) {
            return 1;
        } else {
            return 0;
        }
    });
}

// XXX this whole class could be optimised by having a
// WL.Mesh.isAttributeAvailable API, and a pipeline API, so that we could choose
// whether or not to generate normals and UVs, but there's nothing i can do
// about it for now (the isAttributeAvailable feature could be hacked in, but
// it's very ugly and i'd rather wait)
export class ManifoldBuilder {
    /**
     * The list of all triangles in this manifold. Note that this array might be
     * detached from the builder and replaced with a new array. It is safe to
     * use between operations, but when doing some operations such as
     * subDivide4, a new array will be created.
     */
    triangles = new Array<Triangle>();

    /**
     * Auto-connect edges by checking the vertex positions of each triangle.
     * This can fail if the input is not manifold, or there are 2 or more
     * disconnected surfaces.
     */
    autoConnectEdges(): void {
        const triCount = this.triangles.length;
        if (triCount === 0) {
            return;
        }

        // disconnect all edges
        for (const triangle of this.triangles) {
            let i = 0;
            while (i < 3) {
                triangle.disconnectEdge(i++);
            }
        }

        // recursively connect all triangles, starting from the first one
        const visitedTriangles = new BitArray(triCount);
        connectTriangles(0, this.triangles, visitedTriangles);

        // validate that all triangles have been visited. this makes sure that
        // there is only 1 manifold
        if (!visitedTriangles.isAllSet()) {
            throw new Error('Could not connect all triangles; maybe the surface is not fully connected, or the surface is not trivially manifold?');
        }
    }

    addTriangle(pos0: Readonly<vec3>, pos1: Readonly<vec3>, pos2: Readonly<vec3>): Triangle;
    addTriangle(pos0: Readonly<vec3>, pos1: Readonly<vec3>, pos2: Readonly<vec3>, normal0: Readonly<vec3>, normal1: Readonly<vec3>, normal2: Readonly<vec3>): Triangle;
    addTriangle(pos0: Readonly<vec3>, pos1: Readonly<vec3>, pos2: Readonly<vec3>, uv0: Readonly<vec2>, uv1: Readonly<vec2>, uv2: Readonly<vec2>): Triangle;
    addTriangle(pos0: Readonly<vec3>, pos1: Readonly<vec3>, pos2: Readonly<vec3>, normal0: Readonly<vec3>, normal1: Readonly<vec3>, normal2: Readonly<vec3>, uv0: Readonly<vec2>, uv1: Readonly<vec2>, uv2: Readonly<vec2>): Triangle;
    addTriangle(pos0: Readonly<vec3>, pos1: Readonly<vec3>, pos2: Readonly<vec3>, uvNormal0?: Readonly<vec3> | Readonly<vec2>, uvNormal1?: Readonly<vec3> | Readonly<vec2>, uvNormal2?: Readonly<vec3> | Readonly<vec2>, uv0?: Readonly<vec2>, uv1?: Readonly<vec2>, uv2?: Readonly<vec2>): Triangle {
        const triangle = new Triangle();
        triangle.setPosition(0, pos0);
        triangle.setPosition(1, pos1);
        triangle.setPosition(2, pos2);

        let needsHardNormals = true;

        if (uv0) {
            needsHardNormals = false;
            triangle.setNormal(0, uvNormal0 as vec3);
            triangle.setNormal(1, uvNormal1 as vec3);
            triangle.setNormal(2, uvNormal2 as vec3);
            triangle.setUV(0, uv0);
            triangle.setUV(1, uv1 as vec2);
            triangle.setUV(2, uv2 as vec2);
        } else if (uvNormal0) {
            if (uvNormal0.length === 2) {
                triangle.setUV(0, uvNormal0);
                triangle.setUV(1, uvNormal1 as vec2);
                triangle.setUV(2, uvNormal2 as vec2);
            } else {
                needsHardNormals = false;
                triangle.setNormal(0, uvNormal0 as vec3);
                triangle.setNormal(1, uvNormal1 as vec3);
                triangle.setNormal(2, uvNormal2 as vec3);
            }
        }

        if (needsHardNormals) {
            const temp = normalFromTriangle(pos0, pos1, pos2);
            triangle.setNormal(0, temp);
            triangle.setNormal(1, temp);
            triangle.setNormal(2, temp);
        }

        this.triangles.push(triangle);
        return triangle;
    }

    subDivide4(): void {
        // split triangle into 4, in the same order as the original array.
        // triangles:
        // 0: top triangle (0, 0-1 mid, 2-0 mid)
        // 1: bottom left triangle (0-1 mid, 1, 1-2 mid)
        // 2: bottom right triangle (2-0 mid, 1-2 mid, 2)
        // 3: middle triangle (1-2 mid, 2-0 mid, 0-1 mid)
        const triCount = this.triangles.length;
        const newTriangles = new Array<Triangle>(triCount * 4);

        for (let t = 0, i = 0; t < triCount; t++) {
            const triangle = this.triangles[t];

            // pre-calculate vertices
            const vert0 = triangle.getVertex(0);
            const vert1 = triangle.getVertex(1);
            const vert2 = triangle.getVertex(2);
            const vert01 = getVertexMid(vert0, vert1);
            const vert12 = getVertexMid(vert1, vert2);
            const vert20 = getVertexMid(vert2, vert0);

            // make triangles
            const tTri = Triangle.fromVertices(vert0, vert01, vert20);
            const blTri = Triangle.fromVertices(vert01, vert1, vert12);
            const brTri = Triangle.fromVertices(vert20, vert12, vert2);
            const mTri = Triangle.fromVertices(vert12, vert20, vert01);

            // connect edges of mid triangle
            mTri.connectEdge(0, 0, brTri);
            mTri.connectEdge(1, 1, tTri);
            mTri.connectEdge(2, 2, blTri);

            // save triangles
            newTriangles[i++] = tTri;
            newTriangles[i++] = blTri;
            newTriangles[i++] = brTri;
            newTriangles[i++] = mTri;
        }

        // connect triangles according to original shared edges
        // XXX there are a lot of redundant operations, but i feel like trying
        // to reduce them would be more expensive than keeping it as is
        this.setTriangleHelpers();

        for (let t = 0, i = 0; t < triCount; t++, i += 4) {
            const origTri = this.triangles[t];

            for (let edge = 0; edge < 3; edge++) {
                const edgeConnection = origTri.getConnectedEdge(edge);
                if (edgeConnection) {
                    const [otherEdge, otherTri] = edgeConnection;
                    const ot = otherTri.helper * 4;
                    const oaSubTri = newTriangles[ot + otherEdge];
                    const obSubTri = newTriangles[ot + (otherEdge + 1) % 3];
                    newTriangles[i + edge].connectEdge(edge, otherEdge, obSubTri);
                    newTriangles[i + (edge + 1) % 3].connectEdge(edge, otherEdge, oaSubTri);
                }
            }
        }

        // replace triangle array
        this.triangles = newTriangles;
    }

    normalize(): void {
        for (const triangle of this.triangles) {
            triangle.normalize();
        }
    }

    private finalizeSubmesh(material: WL.Material, triangles: Array<Triangle>, submeshMap: SubmeshMap, submeshIdx: number): Submesh {
        // make index and vertex data in advance
        const triCount = triangles.length;
        // XXX this assumes the worst case; that no vertices are merged
        const indexCount = triCount * 3;
        const [indexData, indexType] = BaseManifoldWLMesh.makeIndexBuffer(indexCount, indexCount);
        const positions = new DynamicArray(Float32Array);
        const normals = new DynamicArray(Float32Array);
        const texCoords = new DynamicArray(Float32Array);

        const hasher = new VertexHasher(8);
        let nextIdx = 0;

        for (let t = 0, iOffset = 0; t < triCount; t++) {
            const triangle = triangles[t];
            const smOffset = triangle.helper * 2;
            submeshMap[smOffset] = submeshIdx;
            submeshMap[smOffset + 1] = t;

            for (let i = 0, offset = 0; i < 3; i++, offset += 8) {
                let offsetCopy = offset;
                const x = triangle.vertexData[offsetCopy++];
                const y = triangle.vertexData[offsetCopy++];
                const z = triangle.vertexData[offsetCopy++];
                const nx = triangle.vertexData[offsetCopy++];
                const ny = triangle.vertexData[offsetCopy++];
                const nz = triangle.vertexData[offsetCopy++];
                const u = triangle.vertexData[offsetCopy++];
                const v = triangle.vertexData[offsetCopy];

                if (hasher.isUnique(triangle.vertexData, offset)) {
                    // console.log('UNIQUE');
                    positions.pushBack_guarded(x);
                    positions.pushBack_guarded(y);
                    positions.pushBack_guarded(z);

                    normals.pushBack_guarded(nx);
                    normals.pushBack_guarded(ny);
                    normals.pushBack_guarded(nz);

                    texCoords.pushBack_guarded(u);
                    texCoords.pushBack_guarded(v);

                    indexData[iOffset++] = nextIdx++;
                } else {
                    // console.log('NOT UNIQUE');
                    let j = 0;
                    for (let k2 = 0, k3 = 0; j < nextIdx; j++, k2 += 2, k3 += 3) {
                        if (positions.get_guarded(k3) === x && positions.get_guarded(k3 + 1) === y && positions.get_guarded(k3 + 2) === z &&
                            normals.get_guarded(k3) === nx && normals.get_guarded(k3 + 1) === ny && normals.get_guarded(k3 + 2) === nz &&
                            texCoords.get_guarded(k2) === u && texCoords.get_guarded(k2 + 1) === v) {
                            break;
                        }
                    }

                    if (j === nextIdx) {
                        throw new Error('Vertex was hashed, but not found in list of vertices');
                    }

                    indexData[iOffset++] = j;
                }
            }
        }

        // instance one mesh
        const vertexCount = positions.length / 3;
        const mesh = new WL.Mesh({ vertexCount, indexData, indexType });

        // upload vertex data
        const positionsAttr = mesh.attribute(WL.MeshAttribute.Position);
        if (!positionsAttr) {
            throw new Error('Could not get position mesh attribute accessor');
        }
        positionsAttr.set(0, positions.finalize());

        const normalsAttr = mesh.attribute(WL.MeshAttribute.Normal);
        if (normalsAttr) {
            normalsAttr.set(0, normals.finalize());
        }

        const texCoordsAttr = mesh.attribute(WL.MeshAttribute.TextureCoordinate);
        if (texCoordsAttr) {
            texCoordsAttr.set(0, texCoords.finalize());
        }

        return [mesh, material];
    }

    finalize(materialMap: Map<number, WL.Material>): [ submeshes: Array<Submesh>, manifoldMesh: Mesh, submeshMap: SubmeshMap ] {
        // group all triangles together by their materials
        const groupedTris = new Map<WL.Material | null, Array<Triangle>>();

        for (const triangle of this.triangles) {
            const materialID = triangle.materialID;
            const material = materialMap.get(materialID) ?? null;
            const submesh = groupedTris.get(material);
            if (submesh) {
                submesh.push(triangle);
            } else {
                groupedTris.set(material, [triangle]);
            }
        }

        // sort materials by ascending material ID
        const sortedMaterials = sortMaterials(groupedTris.keys(), materialMap);

        // count maximum triangle count for each group
        let maxSubmeshTriCount = 0;
        for (const triangles of groupedTris.values()) {
            maxSubmeshTriCount = Math.max(maxSubmeshTriCount, triangles.length);
        }

        // turn groups into submeshes
        const triCount = this.triangles.length;
        const submeshes = new Array<Submesh>();
        const submeshMap: SubmeshMap = BaseManifoldWLMesh.makeSubmeshMapBuffer(triCount, maxSubmeshTriCount, groupedTris.size - 1);
        let submeshIdx = 0;
        this.setTriangleHelpers();

        for (const material of sortedMaterials) {
            const triangles = groupedTris.get(material) as Array<Triangle>;
            submeshes.push(this.finalizeSubmesh(material, triangles, submeshMap, submeshIdx++));
        }

        // prepare manifold mesh data arrays
        const positions = new DynamicArray(Float32Array);
        let nextPosition = 0;
        const indices = new Uint32Array(triCount * 3);
        const INVALID_INDEX = 0xFFFFFFFF; // max uint32
        indices.fill(INVALID_INDEX);

        this.setTriangleHelpers();

        // get positions for each triangle
        for (let t = 0; t < triCount; t++) {
            const indexOffset = t * 3;
            const triangle = this.triangles[t];

            for (let vi = 0; vi < 3; vi++) {
                let index = indices[indexOffset + vi];

                if (index !== INVALID_INDEX) {
                    continue; // vertex already has shared position
                }

                // no shared position yet, make a new position
                index = nextPosition++;
                const vertPos = triangle.getPosition(vi);
                positions.pushBack_guarded(vertPos[0]);
                positions.pushBack_guarded(vertPos[1]);
                positions.pushBack_guarded(vertPos[2]);

                // set all positions in vertex star
                const vertexStar = triangle.getVertexStar(vi);
                for (const [otherTriangle, ovi] of vertexStar) {
                    indices[otherTriangle.helper * 3 + ovi] = index;
                }
            }
        }

        const finalPositions = positions.finalize();

        // TODO use newer manifold api
        const triVerts = new Array(triCount);
        const posCount = finalPositions.length / 3;
        const vertPos = new Array(posCount);
        const manifoldMesh = <Mesh>{ triVerts, vertPos };
        for (let i = 0, j = 0; i < triCount;) {
            triVerts[i++] = [indices[j++], indices[j++], indices[j++]];
        }
        for (let i = 0, j = 0; i < posCount;) {
            vertPos[i++] = [finalPositions[j++], finalPositions[j++], finalPositions[j++]];
        }

        return [submeshes, manifoldMesh, submeshMap];
    }

    translate(offset: vec3): void {
        if (offset[0] === 0 && offset[1] === 0 && offset[2] === 0) {
            return;
        }

        for (const triangle of this.triangles) {
            triangle.translate(offset);
        }
    }

    scale(factor: vec3): void {
        if (factor[0] === 1 && factor[1] === 1 && factor[2] === 1) {
            return;
        }

        for (const triangle of this.triangles) {
            triangle.scale(factor);
        }
    }

    uniformScale(factor: number): void {
        if (factor === 1) {
            return;
        }

        for (const triangle of this.triangles) {
            triangle.uniformScale(factor);
        }
    }

    rotate(rotation: quat): void {
        if (rotation[0] === 0 && rotation[1] === 0 && rotation[2] === 0 && rotation[3] === 1) {
            return;
        }

        for (const triangle of this.triangles) {
            triangle.rotate(rotation);
        }
    }

    transform(matrix: mat4): void {
        if (mat4.exactEquals(matrix, MAT4_IDENTITY)) {
            return;
        }

        for (const triangle of this.triangles) {
            triangle.transform(matrix);
        }
    }

    /**
     * Map triangles back to their indices in the triangles array by setting the
     * helper variable of each triangle.
     */
    setTriangleHelpers(): void {
        const triCount = this.triangles.length;
        for (let i = 0; i < triCount; i++) {
            this.triangles[i].helper = i;
        }
    }

    /**
     * Make UVs for an equirectangular projection. The mapping will always be
     * heavily distorted near the poles as it is impossible to do
     * equirectangular projections properly without custom shaders.
     *
     * Generally, more subdivisions lead to better mappings, but this has
     * diminishing returns.
     */
    makeEquirectUVs(): void {
        const uList = new Array(3);

        for (const triangle of this.triangles) {
            // check if on first or second half of sphere (along yaw)
            let isFirstHalf = false;
            for (let offset = 0, i = 0; offset < 24; offset += 8, i++) {
                // calculate yaw and pitch from normalized position
                const dx = triangle.vertexData[offset];
                const dy = triangle.vertexData[offset + 1];
                const dz = triangle.vertexData[offset + 2];
                const u = Math.atan2(dx, dz) * TAU_INV + 0.5;

                if (u < 0.5) {
                    isFirstHalf = true;
                }

                uList[i] = u;
                triangle.vertexData[offset + 7] = 1 - (Math.atan2(Math.sqrt(dx * dx + dz * dz), dy) * TAU_INV - 0.25);
            }

            // correctly handle wrap-around point
            for (let offset = 6, i = 0; offset < 24; offset += 8, i++) {
                let u = uList[i];
                if (isFirstHalf && u > 0.75) {
                    u -= 1;
                }

                triangle.vertexData[offset] = u;
            }
        }
    }
}