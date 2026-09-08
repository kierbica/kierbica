/**
 * WebGL2 scatter plot.
 *
 * Every matched row becomes one GPU point. Positions are packed into a single
 * interleaved Float32Array and uploaded once per query; pan/zoom afterwards is
 * a uniform update and a single draw call, so interaction stays at 60fps even
 * with a million points. Falls back to a decimated canvas2d path when WebGL2 is
 * unavailable.
 */
import { color, hexRGB } from '../fmt';

const VERT = `#version 300 es
layout(location=0) in vec2 aPos;
layout(location=1) in float aC;

uniform vec4 uBounds;   // minX, minY, spanX, spanY
uniform vec4 uView;     // panX, panY, zoom, pointSize
uniform vec2 uRes;

out vec3 vCol;
out float vAlpha;

vec3 pal(float i) {
  // 18-entry palette, matched to the CSS/canvas palette
  float t = mod(i, 18.0);
  vec3 c;
  if (t < 1.0)       c = vec3(0.302,0.816,1.000);
  else if (t < 2.0)  c = vec3(0.627,0.420,1.000);
  else if (t < 3.0)  c = vec3(0.216,0.886,0.627);
  else if (t < 4.0)  c = vec3(1.000,0.702,0.278);
  else if (t < 5.0)  c = vec3(1.000,0.373,0.427);
  else if (t < 6.0)  c = vec3(0.373,0.659,1.000);
  else if (t < 7.0)  c = vec3(1.000,0.561,0.816);
  else if (t < 8.0)  c = vec3(0.553,0.878,0.416);
  else if (t < 9.0)  c = vec3(1.000,0.878,0.400);
  else if (t < 10.0) c = vec3(0.420,0.890,0.890);
  else if (t < 11.0) c = vec3(0.788,0.545,1.000);
  else if (t < 12.0) c = vec3(1.000,0.604,0.353);
  else if (t < 13.0) c = vec3(0.486,0.910,0.769);
  else if (t < 14.0) c = vec3(1.000,0.478,0.722);
  else if (t < 15.0) c = vec3(0.620,0.796,1.000);
  else if (t < 16.0) c = vec3(0.831,0.878,0.373);
  else if (t < 17.0) c = vec3(0.408,0.847,1.000);
  else               c = vec3(0.722,0.631,1.000);
  return c;
}

void main() {
  vec2 n = (aPos - uBounds.xy) / uBounds.zw;      // 0..1 data space
  vec2 p = (n - 0.5) * 2.0 * uView.z + uView.xy;  // clip space w/ pan+zoom
  gl_Position = vec4(p.x, p.y, 0.0, 1.0);
  gl_PointSize = uView.w;
  vCol = pal(aC);
  vAlpha = 1.0;
}`;

const FRAG = `#version 300 es
precision highp float;
in vec3 vCol;
in float vAlpha;
uniform float uOpacity;
out vec4 fragColor;
void main() {
  // round, feathered sprite
  vec2 d = gl_PointCoord - vec2(0.5);
  float r = dot(d, d);
  if (r > 0.25) discard;
  float a = smoothstep(0.25, 0.06, r);
  fragColor = vec4(vCol, a * uOpacity * vAlpha);
}`;

export class ScatterGL {
  private gl: WebGL2RenderingContext | null = null;
  private prog: WebGLProgram | null = null;
  private vao: WebGLVertexArrayObject | null = null;
  private buf: WebGLBuffer | null = null;
  private loc: Record<string, WebGLUniformLocation | null> = {};
  private n = 0;
  private bounds: [number, number, number, number] = [0, 0, 1, 1];
  private c2d: CanvasRenderingContext2D | null = null;
  private cpuData: Float32Array | null = null;

  pan: [number, number] = [0, 0];
  zoom = 1;
  pointSize = 2.5;
  opacity = 0.55;
  readonly ok: boolean;

  constructor(private cv: HTMLCanvasElement) {
    const gl = cv.getContext('webgl2', {
      alpha: true, antialias: false, premultipliedAlpha: false,
      powerPreference: 'high-performance', desynchronized: true,
    });
    if (gl) {
      this.gl = gl;
      this.ok = this.init();
    } else {
      this.ok = false;
    }
    if (!this.ok) this.c2d = cv.getContext('2d');
  }

  private init(): boolean {
    const gl = this.gl!;
    const vs = compile(gl, gl.VERTEX_SHADER, VERT);
    const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG);
    if (!vs || !fs) return false;
    const p = gl.createProgram()!;
    gl.attachShader(p, vs);
    gl.attachShader(p, fs);
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      console.warn('scatter link failed', gl.getProgramInfoLog(p));
      return false;
    }
    this.prog = p;
    for (const u of ['uBounds', 'uView', 'uRes', 'uOpacity']) {
      this.loc[u] = gl.getUniformLocation(p, u);
    }
    this.vao = gl.createVertexArray();
    this.buf = gl.createBuffer();
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 12, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 1, gl.FLOAT, false, 12, 8);
    gl.bindVertexArray(null);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    return true;
  }

  /** Upload interleaved [x, y, colorIndex] triples. */
  upload(data: Float32Array, n: number, bounds: [number, number, number, number]) {
    this.n = n;
    this.bounds = bounds;
    if (this.gl && this.buf) {
      const gl = this.gl;
      gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
      gl.bufferData(gl.ARRAY_BUFFER, data.subarray(0, n * 3), gl.DYNAMIC_DRAW);
      this.cpuData = null;
    } else {
      this.cpuData = data;
    }
  }

  resize(w: number, h: number, dpr: number) {
    this.cv.width = Math.max(1, Math.round(w * dpr));
    this.cv.height = Math.max(1, Math.round(h * dpr));
    if (this.gl) this.gl.viewport(0, 0, this.cv.width, this.cv.height);
  }

  /** data-space -> normalised 0..1 -> screen px */
  project(x: number, y: number, w: number, h: number): [number, number] {
    const nx = (x - this.bounds[0]) / this.bounds[2];
    const ny = (y - this.bounds[1]) / this.bounds[3];
    const cx = (nx - 0.5) * 2 * this.zoom + this.pan[0];
    const cy = (ny - 0.5) * 2 * this.zoom + this.pan[1];
    return [((cx + 1) / 2) * w, (1 - (cy + 1) / 2) * h];
  }

  unproject(px: number, py: number, w: number, h: number): [number, number] {
    const cx = (px / w) * 2 - 1;
    const cy = (1 - py / h) * 2 - 1;
    const nx = (cx - this.pan[0]) / (2 * this.zoom) + 0.5;
    const ny = (cy - this.pan[1]) / (2 * this.zoom) + 0.5;
    return [nx * this.bounds[2] + this.bounds[0], ny * this.bounds[3] + this.bounds[1]];
  }

  draw() {
    if (this.gl && this.prog) {
      const gl = this.gl;
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      if (this.n === 0) return;
      gl.useProgram(this.prog);
      gl.bindVertexArray(this.vao);
      gl.uniform4f(this.loc.uBounds!, this.bounds[0], this.bounds[1], this.bounds[2], this.bounds[3]);
      const dpr = this.cv.width / Math.max(1, this.cv.clientWidth);
      gl.uniform4f(this.loc.uView!, this.pan[0], this.pan[1], this.zoom, this.pointSize * dpr);
      gl.uniform2f(this.loc.uRes!, this.cv.width, this.cv.height);
      gl.uniform1f(this.loc.uOpacity!, this.opacity);
      gl.drawArrays(gl.POINTS, 0, this.n);
      gl.bindVertexArray(null);
    } else if (this.c2d && this.cpuData) {
      // Fallback: decimate to keep the main thread responsive.
      const c = this.c2d;
      const w = this.cv.width;
      const h = this.cv.height;
      c.clearRect(0, 0, w, h);
      const stride = this.n > 60000 ? Math.ceil(this.n / 60000) : 1;
      c.globalAlpha = this.opacity;
      for (let i = 0; i < this.n; i += stride) {
        const x = this.cpuData[i * 3];
        const y = this.cpuData[i * 3 + 1];
        const ci = this.cpuData[i * 3 + 2];
        const [px, py] = this.project(x, y, w, h);
        c.fillStyle = color(ci | 0);
        c.fillRect(px, py, 2, 2);
      }
      c.globalAlpha = 1;
    }
  }

  dispose() {
    const gl = this.gl;
    if (!gl) return;
    if (this.buf) gl.deleteBuffer(this.buf);
    if (this.vao) gl.deleteVertexArray(this.vao);
    if (this.prog) gl.deleteProgram(this.prog);
  }
}

function compile(gl: WebGL2RenderingContext, type: number, src: string) {
  const s = gl.createShader(type)!;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    console.warn('shader error', gl.getShaderInfoLog(s));
    return null;
  }
  return s;
}

export { hexRGB };
