// Parse 3DGS PLY file for collision detection data
// Adapted from electron-3dgs-viewer/renderer/loader.js

export async function loadPlyForCollision(url) {
    const response = await fetch(url);
    const contentLength = parseInt(response.headers.get('content-length'));
    const reader = response.body.getReader();

    // Download all chunks
    const chunks = [];
    let downloaded = 0;
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        downloaded += value.byteLength;
    }

    // Concatenate chunks
    const buffer = new Uint8Array(downloaded);
    let offset = 0;
    for (const chunk of chunks) {
        buffer.set(chunk, offset);
        offset += chunk.byteLength;
    }

    return parsePlyBuffer(buffer.buffer);
}

function parsePlyBuffer(arrayBuffer) {
    const content = new Uint8Array(arrayBuffer);
    const contentStart = new TextDecoder('utf-8').decode(content.slice(0, 2000));
    const headerEnd = contentStart.indexOf('end_header') + 'end_header'.length + 1;
    const [header] = contentStart.split('end_header');

    const regex = /element vertex (\d+)/;
    const match = header.match(regex);
    const gaussianCount = parseInt(match[1]);

    const positions = [];
    const opacities = [];
    const sceneMin = [Infinity, Infinity, Infinity];
    const sceneMax = [-Infinity, -Infinity, -Infinity];

    const sigmoid = (m1) => 1 / (1 + Math.exp(-m1));
    const NUM_PROPS = 62;

    const view = new DataView(arrayBuffer);

    const fromDataView = (splatID, start, end) => {
        const startOffset = headerEnd + splatID * NUM_PROPS * 4 + start * 4;
        if (end == null) return view.getFloat32(startOffset, true);
        return new Float32Array(end - start).map((_, i) =>
            view.getFloat32(startOffset + i * 4, true)
        );
    };

    for (let i = 0; i < gaussianCount; i++) {
        const position = fromDataView(i, 0, 3);
        const harmonic = fromDataView(i, 6, 9);
        const H_END = 6 + 48;
        const opacity = sigmoid(fromDataView(i, H_END));

        // Update scene bounding box
        for (let j = 0; j < 3; j++) {
            sceneMin[j] = Math.min(sceneMin[j], position[j]);
            sceneMax[j] = Math.max(sceneMax[j], position[j]);
        }

        positions.push(...position);
        opacities.push(opacity);
    }

    console.log(`[PLY Parser] Parsed ${gaussianCount} gaussians for collision`);

    return {
        gaussianCount,
        positions: new Float32Array(positions),
        opacities: new Float32Array(opacities),
        sceneMin,
        sceneMax
    };
}
