//! The wgpu renderer (WebGPU-only). Everything that used to be three.js:
//! per-chunk volume meshes with painted/unpainted ranges, cell outlines,
//! editor overlays (ghosts, selection, constraint lines, brush ring, corner
//! handles), the play-mode body, and the camera matrices.
//!
//! Built for very large worlds: near chunks render individually with
//! per-chunk LOD; far chunks are MERGED into 4×4×4-chunk region meshes at
//! coarse LOD, so a 2000×2000 world is ~a thousand draw calls, not 60k.
//! Chunk buffers exist only where the camera is near — far terrain holds
//! only its merged region buffer, keeping GPU memory O(near + regions).

use crate::mesh::{self, ChunkMesh, MeshOpts};
use crate::store::{ChunkStore, Offsets, Paints, S};
use crate::IV;
use rustc_hash::{FxHashMap, FxHashSet};
use wgpu::util::DeviceExt;

/// Chunk LOD rings (world units, scaled by `lod_scale`): level 1 and 2.
const LOD_DISTS: [f32; 2] = [160.0, 320.0];
/// Cell outlines are editing chrome — hidden beyond this.
const OUTLINE_DIST: f32 = 96.0;
/// Region (4×4×4 chunks) merge handover, with hysteresis.
const REGION_FAR: f32 = 430.0;
const REGION_NEAR: f32 = 370.0;
/// Region LOD levels by distance: level 2 (4×), then 3 (8×), then 4 (16×).
const REGION_LODS: [f32; 2] = [900.0, 1800.0];
const REGION: i32 = 4;
/// Per-frame rebuild budgets.
const CHUNK_BUDGET: usize = 12;
const REGION_BUDGET: usize = 32;

const CLEAR: wgpu::Color = wgpu::Color {
    r: 0.0058,
    g: 0.0069,
    b: 0.0095,
    a: 1.0,
}; // 0x15171b, linear

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct Vert {
    pos: [f32; 3],
    color: [f32; 3],
    uv: [f32; 2],
}

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct OverlayVert {
    pos: [f32; 3],
    color: [f32; 4],
    uv: [f32; 2],
}

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct HandleInst {
    pos: [f32; 3],
    size: f32,
    color: [f32; 4],
}

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct Globals {
    view_proj: [[f32; 4]; 4],
    viewport: [f32; 4], // w, h, unused, unused
}

struct ChunkGpu {
    /// None = meshed and empty (a buried interior chunk) — cached so the
    /// LOD pass doesn't re-queue it every frame.
    bufs: Option<(wgpu::Buffer, wgpu::Buffer)>,
    idx_unpainted: u32,
    idx_total: u32,
    painted_faces: u32,
    outline: Option<(wgpu::Buffer, u32)>,
    level: u8,
    min: [f32; 3],
    max: [f32; 3],
}

struct RegionGpu {
    bufs: Option<(wgpu::Buffer, wgpu::Buffer)>,
    idx: u32,
    level: u8,
    min: [f32; 3],
    max: [f32; 3],
}

/// A dynamic overlay buffer (rebuilt whole whenever its content changes).
#[derive(Default)]
struct Overlay {
    vbuf: Option<wgpu::Buffer>,
    ibuf: Option<wgpu::Buffer>,
    idx: u32,
    verts: u32,
}

#[derive(Clone, Copy)]
pub struct ViewOpts {
    pub sculpted: bool,
    pub tint: bool,
    pub paint: bool,
}

#[derive(Clone, Copy)]
pub struct CameraParams {
    pub eye: [f32; 3],
    pub forward: [f32; 3],
    pub fov_y: f32,
    pub near: f32,
    pub far: f32,
}

pub struct Gfx {
    device: wgpu::Device,
    queue: wgpu::Queue,
    surface: wgpu::Surface<'static>,
    config: wgpu::SurfaceConfiguration,
    depth: wgpu::TextureView,
    msaa: wgpu::TextureView,

    pipe_flat: wgpu::RenderPipeline,
    pipe_tex: wgpu::RenderPipeline,
    pipe_lines: wgpu::RenderPipeline,
    pipe_overlay: wgpu::RenderPipeline,
    pipe_overlay_tex: wgpu::RenderPipeline,
    pipe_body: wgpu::RenderPipeline,
    pipe_handles: wgpu::RenderPipeline,

    globals_buf: wgpu::Buffer,
    globals_bg: wgpu::BindGroup,
    atlas_layout: wgpu::BindGroupLayout,
    atlas_bg: wgpu::BindGroup,
    sampler: wgpu::Sampler,

    chunks: FxHashMap<IV, ChunkGpu>,
    regions: FxHashMap<IV, RegionGpu>,
    /// Region → member chunk positions (rebuilt when the store changes).
    members: FxHashMap<IV, Vec<IV>>,
    members_stale: bool,
    /// Regions currently in merged (far) mode.
    far_regions: FxHashSet<IV>,
    chunk_dirty: FxHashSet<IV>,
    region_dirty: FxHashSet<IV>,

    pub view: ViewOpts,
    pub lod_scale: f32,
    pub tileset_grid: (u32, u32),

    // overlay slots: 0 ghost (quads), 1 selection fill (quads), 2 selection
    // lines, 3 constraint lines, 4 brush ring, 5 axes, 6 stamp ghost
    // (textured quads), 7 player body (solid tris)
    overlays: [Overlay; 8],
    handles_buf: Option<wgpu::Buffer>,
    handles_count: u32,

    // stats for the debug/test facade
    pub last_draw_calls: u32,
}

const SHADER: &str = r#"
struct Globals {
    view_proj: mat4x4<f32>,
    viewport: vec4<f32>,
};
@group(0) @binding(0) var<uniform> g: Globals;
@group(1) @binding(0) var atlas: texture_2d<f32>;
@group(1) @binding(1) var samp: sampler;

struct VolOut {
    @builtin(position) pos: vec4<f32>,
    @location(0) color: vec3<f32>,
    @location(1) uv: vec2<f32>,
};

@vertex
fn vs_vol(@location(0) pos: vec3<f32>, @location(1) color: vec3<f32>, @location(2) uv: vec2<f32>) -> VolOut {
    var out: VolOut;
    out.pos = g.view_proj * vec4<f32>(pos, 1.0);
    out.color = color;
    out.uv = uv;
    return out;
}

@fragment
fn fs_flat(in: VolOut) -> @location(0) vec4<f32> {
    return vec4<f32>(in.color, 1.0);
}

@fragment
fn fs_tex(in: VolOut) -> @location(0) vec4<f32> {
    let t = textureSample(atlas, samp, in.uv);
    if (t.a < 0.5) {
        discard;
    }
    return vec4<f32>(t.rgb * in.color * 2.0, 1.0);
}

struct OvOut {
    @builtin(position) pos: vec4<f32>,
    @location(0) color: vec4<f32>,
    @location(1) uv: vec2<f32>,
};

@vertex
fn vs_ov(@location(0) pos: vec3<f32>, @location(1) color: vec4<f32>, @location(2) uv: vec2<f32>) -> OvOut {
    var out: OvOut;
    out.pos = g.view_proj * vec4<f32>(pos, 1.0);
    out.color = color;
    out.uv = uv;
    return out;
}

@fragment
fn fs_ov(in: OvOut) -> @location(0) vec4<f32> {
    return in.color;
}

@fragment
fn fs_ov_tex(in: OvOut) -> @location(0) vec4<f32> {
    let t = textureSample(atlas, samp, in.uv);
    if (t.a < 0.5) {
        discard;
    }
    return vec4<f32>(t.rgb, in.color.a);
}

struct HandleOut {
    @builtin(position) pos: vec4<f32>,
    @location(0) color: vec4<f32>,
    @location(1) corner: vec2<f32>,
};

@vertex
fn vs_handle(
    @builtin(vertex_index) vi: u32,
    @location(0) center: vec3<f32>,
    @location(1) size: f32,
    @location(2) color: vec4<f32>,
) -> HandleOut {
    var corners = array<vec2<f32>, 6>(
        vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, -1.0), vec2<f32>(1.0, 1.0),
        vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, 1.0), vec2<f32>(-1.0, 1.0),
    );
    let c = corners[vi];
    var out: HandleOut;
    var clip = g.view_proj * vec4<f32>(center, 1.0);
    // pixel-sized billboard: offset in NDC by size/viewport
    clip.x += c.x * size * clip.w / g.viewport.x;
    clip.y += c.y * size * clip.w / g.viewport.y;
    out.pos = clip;
    out.color = color;
    out.corner = c;
    return out;
}

@fragment
fn fs_handle(in: HandleOut) -> @location(0) vec4<f32> {
    if (dot(in.corner, in.corner) > 1.0) {
        discard;
    }
    return in.color;
}
"#;

// -- matrices (column-major, WebGPU 0..1 clip z) --------------------------------

fn perspective(fov_y: f32, aspect: f32, near: f32, far: f32) -> [[f32; 4]; 4] {
    let f = 1.0 / (fov_y * 0.5).tan();
    let r = far / (near - far);
    [
        [f / aspect, 0.0, 0.0, 0.0],
        [0.0, f, 0.0, 0.0],
        [0.0, 0.0, r, -1.0],
        [0.0, 0.0, r * near, 0.0],
    ]
}

fn look_to(eye: [f32; 3], dir: [f32; 3]) -> [[f32; 4]; 4] {
    let f = norm(dir);
    let s = norm(cross(f, [0.0, 1.0, 0.0]));
    let u = cross(s, f);
    [
        [s[0], u[0], -f[0], 0.0],
        [s[1], u[1], -f[1], 0.0],
        [s[2], u[2], -f[2], 0.0],
        [-dot(s, eye), -dot(u, eye), dot(f, eye), 1.0],
    ]
}

fn mat_mul(a: [[f32; 4]; 4], b: [[f32; 4]; 4]) -> [[f32; 4]; 4] {
    let mut out = [[0.0f32; 4]; 4];
    for c in 0..4 {
        for r in 0..4 {
            out[c][r] = (0..4).map(|k| a[k][r] * b[c][k]).sum();
        }
    }
    out
}

fn cross(a: [f32; 3], b: [f32; 3]) -> [f32; 3] {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

fn dot(a: [f32; 3], b: [f32; 3]) -> f32 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

fn norm(a: [f32; 3]) -> [f32; 3] {
    let l = dot(a, a).sqrt().max(1e-9);
    [a[0] / l, a[1] / l, a[2] / l]
}

/// Frustum planes (nx, ny, nz, d) from a column-major view-proj matrix.
fn frustum_planes(m: &[[f32; 4]; 4]) -> [[f32; 4]; 6] {
    let row = |r: usize| [m[0][r], m[1][r], m[2][r], m[3][r]];
    let (r0, r1, r2, r3) = (row(0), row(1), row(2), row(3));
    let add = |a: [f32; 4], b: [f32; 4]| [a[0] + b[0], a[1] + b[1], a[2] + b[2], a[3] + b[3]];
    let sub = |a: [f32; 4], b: [f32; 4]| [a[0] - b[0], a[1] - b[1], a[2] - b[2], a[3] - b[3]];
    [
        add(r3, r0), // left
        sub(r3, r0), // right
        add(r3, r1), // bottom
        sub(r3, r1), // top
        r2,          // near (0..1 clip)
        sub(r3, r2), // far
    ]
}

fn aabb_visible(planes: &[[f32; 4]; 6], min: [f32; 3], max: [f32; 3]) -> bool {
    for p in planes {
        let x = if p[0] >= 0.0 { max[0] } else { min[0] };
        let y = if p[1] >= 0.0 { max[1] } else { min[1] };
        let z = if p[2] >= 0.0 { max[2] } else { min[2] };
        if p[0] * x + p[1] * y + p[2] * z + p[3] < 0.0 {
            return false;
        }
    }
    true
}

impl Gfx {
    pub async fn new(
        canvas: web_sys::HtmlCanvasElement,
        width: u32,
        height: u32,
    ) -> Result<Gfx, String> {
        let instance =
            wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle());
        let surface = instance
            .create_surface(wgpu::SurfaceTarget::Canvas(canvas))
            .map_err(|e| format!("create_surface: {e}"))?;
        let adapter = instance
            .request_adapter(&wgpu::RequestAdapterOptions {
                power_preference: wgpu::PowerPreference::HighPerformance,
                compatible_surface: Some(&surface),
                force_fallback_adapter: false,
                apply_limit_buckets: false,
            })
            .await
            .map_err(|e| format!("request_adapter: {e}"))?;
        let (device, queue) = adapter
            .request_device(&wgpu::DeviceDescriptor {
                label: Some("boxexplore"),
                ..Default::default()
            })
            .await
            .map_err(|e| format!("request_device: {e}"))?;

        let caps = surface.get_capabilities(&adapter);
        let format = caps
            .formats
            .iter()
            .copied()
            .find(|f| f.is_srgb())
            .unwrap_or(caps.formats[0]);
        let mut config = surface
            .get_default_config(&adapter, width.max(1), height.max(1))
            .ok_or("surface has no default config")?;
        config.format = format;
        config.present_mode = wgpu::PresentMode::AutoVsync;
        surface.configure(&device, &config);
        let depth = Self::make_depth(&device, &config);
        let msaa = Self::make_msaa(&device, &config);

        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("shader"),
            source: wgpu::ShaderSource::Wgsl(SHADER.into()),
        });

        let globals_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("globals"),
            entries: &[wgpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: wgpu::ShaderStages::VERTEX,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Uniform,
                    has_dynamic_offset: false,
                    min_binding_size: None,
                },
                count: None,
            }],
        });
        let atlas_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("atlas"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float { filterable: true },
                        view_dimension: wgpu::TextureViewDimension::D2,
                        multisampled: false,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                    count: None,
                },
            ],
        });

        let globals_buf = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("globals"),
            size: std::mem::size_of::<Globals>() as u64,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let globals_bg = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("globals"),
            layout: &globals_layout,
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: globals_buf.as_entire_binding(),
            }],
        });

        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("atlas"),
            mag_filter: wgpu::FilterMode::Nearest,
            min_filter: wgpu::FilterMode::Nearest,
            ..Default::default()
        });
        // 1×1 white placeholder until the tileset uploads
        let atlas_bg = Self::make_atlas_bg(
            &device,
            &queue,
            &atlas_layout,
            &sampler,
            1,
            1,
            &[255, 255, 255, 255],
        );

        let layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("main"),
            bind_group_layouts: &[Some(&globals_layout), Some(&atlas_layout)],
            immediate_size: 0,
        });

        let vol_layout = wgpu::VertexBufferLayout {
            array_stride: std::mem::size_of::<Vert>() as u64,
            step_mode: wgpu::VertexStepMode::Vertex,
            attributes: &wgpu::vertex_attr_array![0 => Float32x3, 1 => Float32x3, 2 => Float32x2],
        };
        let ov_layout = wgpu::VertexBufferLayout {
            array_stride: std::mem::size_of::<OverlayVert>() as u64,
            step_mode: wgpu::VertexStepMode::Vertex,
            attributes: &wgpu::vertex_attr_array![0 => Float32x3, 1 => Float32x4, 2 => Float32x2],
        };
        let handle_layout = wgpu::VertexBufferLayout {
            array_stride: std::mem::size_of::<HandleInst>() as u64,
            step_mode: wgpu::VertexStepMode::Instance,
            attributes: &wgpu::vertex_attr_array![0 => Float32x3, 1 => Float32, 2 => Float32x4],
        };

        let make = |entry_fs: &str,
                    vs: &str,
                    buffers: &[Option<wgpu::VertexBufferLayout>],
                    topology: wgpu::PrimitiveTopology,
                    blend: Option<wgpu::BlendState>,
                    depth_write: bool,
                    depth_test: bool,
                    bias: i32,
                    cull: Option<wgpu::Face>| {
            device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some(entry_fs),
                layout: Some(&layout),
                vertex: wgpu::VertexState {
                    module: &shader,
                    entry_point: Some(vs),
                    compilation_options: Default::default(),
                    buffers,
                },
                primitive: wgpu::PrimitiveState {
                    topology,
                    cull_mode: cull,
                    ..Default::default()
                },
                depth_stencil: Some(wgpu::DepthStencilState {
                    format: wgpu::TextureFormat::Depth24Plus,
                    depth_write_enabled: Some(depth_write),
                    depth_compare: Some(if depth_test {
                        wgpu::CompareFunction::Less
                    } else {
                        wgpu::CompareFunction::Always
                    }),
                    stencil: Default::default(),
                    bias: wgpu::DepthBiasState {
                        constant: bias,
                        slope_scale: bias as f32,
                        clamp: 0.0,
                    },
                }),
                multisample: wgpu::MultisampleState {
                    count: 4,
                    ..Default::default()
                },
                fragment: Some(wgpu::FragmentState {
                    module: &shader,
                    entry_point: Some(entry_fs),
                    compilation_options: Default::default(),
                    targets: &[Some(wgpu::ColorTargetState {
                        format,
                        blend,
                        write_mask: wgpu::ColorWrites::ALL,
                    })],
                }),
                multiview_mask: None,
                cache: None,
            })
        };

        let alpha = Some(wgpu::BlendState::ALPHA_BLENDING);
        let tris = wgpu::PrimitiveTopology::TriangleList;
        let lines = wgpu::PrimitiveTopology::LineList;
        let pipe_flat = make("fs_flat", "vs_vol", &[Some(vol_layout.clone())], tris, None, true, true, 1, None);
        let pipe_tex = make("fs_tex", "vs_vol", &[Some(vol_layout.clone())], tris, None, true, true, 1, None);
        let pipe_lines = make("fs_ov", "vs_ov", &[Some(ov_layout.clone())], lines, alpha, false, true, 0, None);
        let pipe_overlay = make("fs_ov", "vs_ov", &[Some(ov_layout.clone())], tris, alpha, false, true, -4, None);
        let pipe_overlay_tex = make("fs_ov_tex", "vs_ov", &[Some(ov_layout.clone())], tris, alpha, false, true, -4, None);
        let pipe_body = make("fs_ov", "vs_ov", &[Some(ov_layout.clone())], tris, alpha, true, true, 0, None);
        let pipe_handles = make("fs_handle", "vs_handle", &[Some(handle_layout)], tris, alpha, false, false, 0, None);

        Ok(Gfx {
            device,
            queue,
            surface,
            config,
            depth,
            msaa,
            pipe_flat,
            pipe_tex,
            pipe_lines,
            pipe_overlay,
            pipe_overlay_tex,
            pipe_body,
            pipe_handles,
            globals_buf,
            globals_bg,
            atlas_layout,
            atlas_bg,
            sampler,
            chunks: FxHashMap::default(),
            regions: FxHashMap::default(),
            members: FxHashMap::default(),
            members_stale: true,
            far_regions: FxHashSet::default(),
            chunk_dirty: FxHashSet::default(),
            region_dirty: FxHashSet::default(),
            view: ViewOpts {
                sculpted: true,
                tint: false,
                paint: true,
            },
            lod_scale: 1.0,
            tileset_grid: (8, 8),
            overlays: Default::default(),
            handles_buf: None,
            handles_count: 0,
            last_draw_calls: 0,
        })
    }

    fn make_depth(device: &wgpu::Device, config: &wgpu::SurfaceConfiguration) -> wgpu::TextureView {
        device
            .create_texture(&wgpu::TextureDescriptor {
                label: Some("depth"),
                size: wgpu::Extent3d {
                    width: config.width,
                    height: config.height,
                    depth_or_array_layers: 1,
                },
                mip_level_count: 1,
                sample_count: 4,
                dimension: wgpu::TextureDimension::D2,
                format: wgpu::TextureFormat::Depth24Plus,
                usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
                view_formats: &[],
            })
            .create_view(&Default::default())
    }

    fn make_msaa(device: &wgpu::Device, config: &wgpu::SurfaceConfiguration) -> wgpu::TextureView {
        device
            .create_texture(&wgpu::TextureDescriptor {
                label: Some("msaa"),
                size: wgpu::Extent3d {
                    width: config.width,
                    height: config.height,
                    depth_or_array_layers: 1,
                },
                mip_level_count: 1,
                sample_count: 4,
                dimension: wgpu::TextureDimension::D2,
                format: config.format,
                usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
                view_formats: &[],
            })
            .create_view(&Default::default())
    }

    fn make_atlas_bg(
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        layout: &wgpu::BindGroupLayout,
        sampler: &wgpu::Sampler,
        w: u32,
        h: u32,
        rgba: &[u8],
    ) -> wgpu::BindGroup {
        let tex = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("atlas"),
            size: wgpu::Extent3d {
                width: w,
                height: h,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8UnormSrgb,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });
        queue.write_texture(
            wgpu::TexelCopyTextureInfo {
                texture: &tex,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            rgba,
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(4 * w),
                rows_per_image: Some(h),
            },
            wgpu::Extent3d {
                width: w,
                height: h,
                depth_or_array_layers: 1,
            },
        );
        let view = tex.create_view(&Default::default());
        device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("atlas"),
            layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(&view),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::Sampler(sampler),
                },
            ],
        })
    }

    pub fn set_tileset(&mut self, w: u32, h: u32, rgba: &[u8]) {
        self.atlas_bg = Self::make_atlas_bg(
            &self.device,
            &self.queue,
            &self.atlas_layout,
            &self.sampler,
            w.max(1),
            h.max(1),
            rgba,
        );
    }

    pub fn resize(&mut self, w: u32, h: u32) {
        if w == 0 || h == 0 {
            return;
        }
        self.config.width = w;
        self.config.height = h;
        self.surface.configure(&self.device, &self.config);
        self.depth = Self::make_depth(&self.device, &self.config);
        self.msaa = Self::make_msaa(&self.device, &self.config);
    }

    /// Everything must remesh (view toggles, tileset grid change, doc load).
    pub fn invalidate_all(&mut self) {
        self.chunks.clear();
        self.regions.clear();
        self.far_regions.clear();
        self.chunk_dirty.clear();
        self.region_dirty.clear();
        self.members_stale = true;
    }

    // -- overlay setters (flat float arrays from the shell) ----------------------

    fn upload_overlay(&mut self, which: usize, verts: &[OverlayVert], indices: &[u32]) {
        let ov = &mut self.overlays[which.min(7)];
        if verts.is_empty() {
            ov.idx = 0;
            ov.verts = 0;
            return;
        }
        ov.vbuf = Some(self.device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("overlay"),
            contents: bytemuck::cast_slice(verts),
            usage: wgpu::BufferUsages::VERTEX,
        }));
        if !indices.is_empty() {
            ov.ibuf = Some(self.device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("overlay-idx"),
                contents: bytemuck::cast_slice(indices),
                usage: wgpu::BufferUsages::INDEX,
            }));
        } else {
            ov.ibuf = None;
        }
        ov.idx = indices.len() as u32;
        ov.verts = verts.len() as u32;
    }

    /// Quads: 12 floats each [bl,br,tr,tl]·xyz. `uvs`: 8 per quad or empty.
    /// Builds two triangles per quad with a constant RGBA.
    pub fn set_overlay_quads(
        &mut self,
        which: usize,
        quads: &[f32],
        uvs: &[f32],
        color: [f32; 4],
    ) {
        let n = quads.len() / 12;
        let mut verts = Vec::with_capacity(n * 4);
        let mut indices = Vec::with_capacity(n * 6);
        for q in 0..n {
            for k in 0..4 {
                let uv = if uvs.len() >= (q * 8 + k * 2 + 2) {
                    [uvs[q * 8 + k * 2], uvs[q * 8 + k * 2 + 1]]
                } else {
                    [0.0, 0.0]
                };
                verts.push(OverlayVert {
                    pos: [
                        quads[q * 12 + k * 3],
                        quads[q * 12 + k * 3 + 1],
                        quads[q * 12 + k * 3 + 2],
                    ],
                    color,
                    uv,
                });
            }
            let b = (q * 4) as u32;
            indices.extend_from_slice(&[b, b + 1, b + 2, b, b + 2, b + 3]);
        }
        self.upload_overlay(which, &verts, &indices);
    }

    /// Line segments: pairs of xyz points with a constant RGBA.
    pub fn set_overlay_lines(&mut self, which: usize, points: &[f32], color: [f32; 4]) {
        let verts: Vec<OverlayVert> = points
            .chunks_exact(3)
            .map(|p| OverlayVert {
                pos: [p[0], p[1], p[2]],
                color,
                uv: [0.0, 0.0],
            })
            .collect();
        self.upload_overlay(which, &verts, &[]);
    }

    /// Colored line segments: per-point xyz + rgba interleaved (7 floats).
    pub fn set_overlay_lines_colored(&mut self, which: usize, data: &[f32]) {
        let verts: Vec<OverlayVert> = data
            .chunks_exact(7)
            .map(|p| OverlayVert {
                pos: [p[0], p[1], p[2]],
                color: [p[3], p[4], p[5], p[6]],
                uv: [0.0, 0.0],
            })
            .collect();
        self.upload_overlay(which, &verts, &[]);
    }

    /// Player body: prebuilt triangle list (pos3+rgba4 per vertex).
    pub fn set_player(&mut self, data: &[f32]) {
        let verts: Vec<OverlayVert> = data
            .chunks_exact(7)
            .map(|p| OverlayVert {
                pos: [p[0], p[1], p[2]],
                color: [p[3], p[4], p[5], p[6]],
                uv: [0.0, 0.0],
            })
            .collect();
        self.upload_overlay(7, &verts, &[]);
    }

    /// Corner handles: (xyz, pixel size, rgba) per instance — 8 floats.
    pub fn set_handles(&mut self, data: &[f32]) {
        let inst: Vec<HandleInst> = data
            .chunks_exact(8)
            .map(|p| HandleInst {
                pos: [p[0], p[1], p[2]],
                size: p[3],
                color: [p[4], p[5], p[6], p[7]],
            })
            .collect();
        self.handles_count = inst.len() as u32;
        self.handles_buf = if inst.is_empty() {
            None
        } else {
            Some(self.device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("handles"),
                contents: bytemuck::cast_slice(&inst),
                usage: wgpu::BufferUsages::VERTEX,
            }))
        };
    }

    // -- chunk/region meshing ------------------------------------------------------

    fn upload_mesh(&self, m: &ChunkMesh) -> Option<(wgpu::Buffer, wgpu::Buffer)> {
        if m.indices.is_empty() {
            return None;
        }
        let n = m.positions.len() / 3;
        let mut verts = Vec::with_capacity(n);
        for i in 0..n {
            verts.push(Vert {
                pos: [
                    m.positions[i * 3],
                    m.positions[i * 3 + 1],
                    m.positions[i * 3 + 2],
                ],
                color: [m.colors[i * 3], m.colors[i * 3 + 1], m.colors[i * 3 + 2]],
                uv: if m.uvs.len() >= i * 2 + 2 {
                    [m.uvs[i * 2], m.uvs[i * 2 + 1]]
                } else {
                    [0.0, 0.0]
                },
            });
        }
        let vbuf = self.device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("chunk-v"),
            contents: bytemuck::cast_slice(&verts),
            usage: wgpu::BufferUsages::VERTEX,
        });
        let ibuf = self.device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("chunk-i"),
            contents: bytemuck::cast_slice(&m.indices),
            usage: wgpu::BufferUsages::INDEX,
        });
        Some((vbuf, ibuf))
    }

    fn build_chunk(
        &mut self,
        store: &ChunkStore,
        offsets: &Offsets,
        paints: &Paints,
        cp: IV,
        level: u8,
    ) {
        let m = if level == 0 {
            mesh::mesh_chunk(
                store,
                offsets,
                paints,
                cp,
                &MeshOpts {
                    sculpted: self.view.sculpted,
                    tint: self.view.tint,
                    paint: self.view.paint,
                    grid: self.tileset_grid,
                },
            )
        } else {
            mesh::mesh_chunk_lod(store, cp, level as u32)
        };
        let bufs = self.upload_mesh(&m);
        // outline: the 4 edges of each quad, level 0 only
        let outline = if level == 0 && !m.indices.is_empty() {
            let quads = m.positions.len() / 12;
            let mut pts: Vec<OverlayVert> = Vec::with_capacity(quads * 8);
            let color = [0.043, 0.05, 0.066, 0.4]; // 0x0e1013
            for q in 0..quads {
                for k in 0..4 {
                    for idx in [q * 4 + k, q * 4 + (k + 1) % 4] {
                        pts.push(OverlayVert {
                            pos: [
                                m.positions[idx * 3],
                                m.positions[idx * 3 + 1],
                                m.positions[idx * 3 + 2],
                            ],
                            color,
                            uv: [0.0, 0.0],
                        });
                    }
                }
            }
            let buf = self.device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("outline"),
                contents: bytemuck::cast_slice(&pts),
                usage: wgpu::BufferUsages::VERTEX,
            });
            Some((buf, pts.len() as u32))
        } else {
            None
        };
        let total_faces = m.face_count() as u32;
        let base = [(cp.0 * S) as f32, (cp.1 * S) as f32, (cp.2 * S) as f32];
        self.chunks.insert(
            cp,
            ChunkGpu {
                bufs,
                idx_unpainted: (m.unpainted_faces * 6) as u32,
                idx_total: (total_faces * 6) as u32,
                painted_faces: total_faces - m.unpainted_faces as u32,
                outline,
                level,
                min: [base[0] - 0.5, base[1] - 0.5, base[2] - 0.5],
                max: [
                    base[0] + S as f32 + 0.5,
                    base[1] + S as f32 + 0.5,
                    base[2] + S as f32 + 0.5,
                ],
            },
        );
    }

    fn build_region(&mut self, store: &ChunkStore, rp: IV, level: u8) {
        let Some(members) = self.members.get(&rp) else {
            self.regions.remove(&rp);
            return;
        };
        let mut merged = ChunkMesh::default();
        for cp in members {
            let m = mesh::mesh_chunk_lod(store, *cp, level as u32);
            merged.append(m);
        }
        let bufs = self.upload_mesh(&merged);
        let base = [
            (rp.0 * REGION * S) as f32,
            (rp.1 * REGION * S) as f32,
            (rp.2 * REGION * S) as f32,
        ];
        let side = (REGION * S) as f32;
        self.regions.insert(
            rp,
            RegionGpu {
                bufs,
                idx: (merged.face_count() * 6) as u32,
                level,
                min: base,
                max: [base[0] + side, base[1] + side, base[2] + side],
            },
        );
    }

    fn rebuild_members(&mut self, store: &ChunkStore) {
        self.members.clear();
        for cp in store.chunks.keys() {
            let rp = (
                cp.0.div_euclid(REGION),
                cp.1.div_euclid(REGION),
                cp.2.div_euclid(REGION),
            );
            self.members.entry(rp).or_default().push(*cp);
        }
        self.members_stale = false;
    }

    // -- the frame -------------------------------------------------------------------

    #[allow(clippy::too_many_arguments)]
    pub fn frame(
        &mut self,
        store: &mut ChunkStore,
        offsets: &Offsets,
        paints: &Paints,
        cam: &CameraParams,
    ) {
        // 1. absorb document dirt
        if !store.dirty.is_empty() {
            self.members_stale = true;
            for cp in store.dirty.drain().collect::<Vec<_>>() {
                let rp = (
                    cp.0.div_euclid(REGION),
                    cp.1.div_euclid(REGION),
                    cp.2.div_euclid(REGION),
                );
                if self.far_regions.contains(&rp) {
                    self.region_dirty.insert(rp);
                } else {
                    self.chunk_dirty.insert(cp);
                }
            }
        }
        if self.members_stale {
            self.rebuild_members(store);
        }

        let eye = cam.eye;
        let k = self.lod_scale;
        let dist_to = |min: [f32; 3], max: [f32; 3]| -> f32 {
            let mut d2 = 0.0;
            for a in 0..3 {
                let v = eye[a].clamp(min[a], max[a]) - eye[a];
                d2 += v * v;
            }
            d2.sqrt()
        };

        // 2. region far/near transitions + desired levels
        let side = (REGION * S) as f32;
        let region_keys: Vec<IV> = self.members.keys().copied().collect();
        for rp in &region_keys {
            let min = [
                (rp.0 as f32) * side,
                (rp.1 as f32) * side,
                (rp.2 as f32) * side,
            ];
            let max = [min[0] + side, min[1] + side, min[2] + side];
            let d = dist_to(min, max);
            let far = self.far_regions.contains(rp);
            if far && d < REGION_NEAR * k {
                // near again: hand back to per-chunk meshes
                self.far_regions.remove(rp);
                self.regions.remove(rp);
                self.region_dirty.remove(rp);
                for cp in &self.members[rp] {
                    self.chunk_dirty.insert(*cp);
                }
            } else if !far && d > REGION_FAR * k {
                self.far_regions.insert(*rp);
                self.region_dirty.insert(*rp);
                for cp in &self.members[rp] {
                    self.chunks.remove(cp);
                    self.chunk_dirty.remove(cp);
                }
            } else if far {
                let want = if d > REGION_LODS[1] * k {
                    4u8
                } else if d > REGION_LODS[0] * k {
                    3
                } else {
                    2
                };
                if self
                    .regions
                    .get(rp)
                    .is_none_or(|r| r.level != want)
                {
                    self.region_dirty.insert(*rp);
                }
            }
        }
        // drop stale far flags for regions that lost all chunks
        self.far_regions.retain(|rp| self.members.contains_key(rp));
        self.regions.retain(|rp, _| self.members.contains_key(rp));

        // 3. near-chunk LOD desires
        for (rp, members) in &self.members {
            if self.far_regions.contains(rp) {
                continue;
            }
            for cp in members {
                let min = [
                    (cp.0 * S) as f32,
                    (cp.1 * S) as f32,
                    (cp.2 * S) as f32,
                ];
                let max = [min[0] + S as f32, min[1] + S as f32, min[2] + S as f32];
                let d = dist_to(min, max);
                let want = if d > LOD_DISTS[1] * k {
                    2u8
                } else if d > LOD_DISTS[0] * k {
                    1
                } else {
                    0
                };
                match self.chunks.get(cp) {
                    Some(c) if c.level == want => {}
                    _ => {
                        self.chunk_dirty.insert(*cp);
                    }
                }
            }
        }

        // 4. budgeted rebuilds, nearest first
        if !self.chunk_dirty.is_empty() {
            // Budget counts FACE-PRODUCING rebuilds — buried interior chunks
            // mesh to nothing almost instantly and shouldn't eat the budget
            // (a deep world queues tens of thousands of them). Small scenes
            // rebuild fully within the frame (keeps edits and the test
            // suite synchronous); big worlds go nearest-first.
            let small = self.chunk_dirty.len() <= 64;
            let mut list: Vec<IV> = self.chunk_dirty.iter().copied().collect();
            list.sort_by(|a, b| {
                let da = dist_to(
                    [(a.0 * S) as f32, (a.1 * S) as f32, (a.2 * S) as f32],
                    [((a.0 + 1) * S) as f32, ((a.1 + 1) * S) as f32, ((a.2 + 1) * S) as f32],
                );
                let db = dist_to(
                    [(b.0 * S) as f32, (b.1 * S) as f32, (b.2 * S) as f32],
                    [((b.0 + 1) * S) as f32, ((b.1 + 1) * S) as f32, ((b.2 + 1) * S) as f32],
                );
                da.total_cmp(&db)
            });
            let mut built = 0usize;
            let mut popped = 0usize;
            for cp in list {
                if !small && (built >= CHUNK_BUDGET || popped >= 4096) {
                    break;
                }
                popped += 1;
                self.chunk_dirty.remove(&cp);
                let rp = (
                    cp.0.div_euclid(REGION),
                    cp.1.div_euclid(REGION),
                    cp.2.div_euclid(REGION),
                );
                if self.far_regions.contains(&rp) {
                    continue;
                }
                let min = [(cp.0 * S) as f32, (cp.1 * S) as f32, (cp.2 * S) as f32];
                let max = [min[0] + S as f32, min[1] + S as f32, min[2] + S as f32];
                let d = dist_to(min, max);
                let level = if d > LOD_DISTS[1] * k {
                    2u8
                } else if d > LOD_DISTS[0] * k {
                    1
                } else {
                    0
                };
                self.build_chunk(store, offsets, paints, cp, level);
                if self
                    .chunks
                    .get(&cp)
                    .is_some_and(|c| c.bufs.is_some())
                {
                    built += 1;
                }
            }
        }
        if !self.region_dirty.is_empty() {
            let list: Vec<IV> = self.region_dirty.iter().copied().take(REGION_BUDGET).collect();
            for rp in list {
                self.region_dirty.remove(&rp);
                if !self.far_regions.contains(&rp) {
                    continue;
                }
                let min = [
                    (rp.0 as f32) * side,
                    (rp.1 as f32) * side,
                    (rp.2 as f32) * side,
                ];
                let max = [min[0] + side, min[1] + side, min[2] + side];
                let d = dist_to(min, max);
                let level = if d > REGION_LODS[1] * k {
                    4u8
                } else if d > REGION_LODS[0] * k {
                    3
                } else {
                    2
                };
                self.build_region(store, rp, level);
            }
        }

        // 5. draw
        let aspect = self.config.width as f32 / self.config.height.max(1) as f32;
        let proj = perspective(cam.fov_y, aspect, cam.near, cam.far);
        let view = look_to(cam.eye, cam.forward);
        let view_proj = mat_mul(proj, view);
        let planes = frustum_planes(&view_proj);
        self.queue.write_buffer(
            &self.globals_buf,
            0,
            bytemuck::bytes_of(&Globals {
                view_proj,
                viewport: [
                    self.config.width as f32,
                    self.config.height as f32,
                    0.0,
                    0.0,
                ],
            }),
        );

        use wgpu::CurrentSurfaceTexture as Cur;
        let frame = match self.surface.get_current_texture() {
            Cur::Success(f) | Cur::Suboptimal(f) => f,
            Cur::Outdated | Cur::Lost => {
                self.surface.configure(&self.device, &self.config);
                match self.surface.get_current_texture() {
                    Cur::Success(f) | Cur::Suboptimal(f) => f,
                    _ => return,
                }
            }
            _ => return,
        };
        let target = frame.texture.create_view(&Default::default());
        let mut enc = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("frame") });
        let mut draws = 0u32;
        {
            let mut pass = enc.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("main"),
                multiview_mask: None,
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &self.msaa,
                    depth_slice: None,
                    resolve_target: Some(&target),
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(CLEAR),
                        store: wgpu::StoreOp::Discard,
                    },
                })],
                depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment {
                    view: &self.depth,
                    depth_ops: Some(wgpu::Operations {
                        load: wgpu::LoadOp::Clear(1.0),
                        store: wgpu::StoreOp::Discard,
                    }),
                    stencil_ops: None,
                }),
                occlusion_query_set: None,
                timestamp_writes: None,
            });
            pass.set_bind_group(0, &self.globals_bg, &[]);
            pass.set_bind_group(1, &self.atlas_bg, &[]);

            // opaque volume: unpainted ranges
            pass.set_pipeline(&self.pipe_flat);
            for c in self.chunks.values() {
                let Some((vbuf, ibuf)) = &c.bufs else { continue };
                if c.idx_unpainted == 0 || !aabb_visible(&planes, c.min, c.max) {
                    continue;
                }
                pass.set_vertex_buffer(0, vbuf.slice(..));
                pass.set_index_buffer(ibuf.slice(..), wgpu::IndexFormat::Uint32);
                pass.draw_indexed(0..c.idx_unpainted, 0, 0..1);
                draws += 1;
            }
            for r in self.regions.values() {
                let Some((vbuf, ibuf)) = &r.bufs else { continue };
                if r.idx == 0 || !aabb_visible(&planes, r.min, r.max) {
                    continue;
                }
                pass.set_vertex_buffer(0, vbuf.slice(..));
                pass.set_index_buffer(ibuf.slice(..), wgpu::IndexFormat::Uint32);
                pass.draw_indexed(0..r.idx, 0, 0..1);
                draws += 1;
            }
            // painted ranges (atlas)
            pass.set_pipeline(&self.pipe_tex);
            for c in self.chunks.values() {
                let Some((vbuf, ibuf)) = &c.bufs else { continue };
                if c.idx_total <= c.idx_unpainted || !aabb_visible(&planes, c.min, c.max) {
                    continue;
                }
                pass.set_vertex_buffer(0, vbuf.slice(..));
                pass.set_index_buffer(ibuf.slice(..), wgpu::IndexFormat::Uint32);
                pass.draw_indexed(c.idx_unpainted..c.idx_total, 0, 0..1);
                draws += 1;
            }
            // cell outlines near the camera
            pass.set_pipeline(&self.pipe_lines);
            for c in self.chunks.values() {
                let Some((buf, count)) = &c.outline else {
                    continue;
                };
                if c.level != 0 || !aabb_visible(&planes, c.min, c.max) {
                    continue;
                }
                let d = dist_to(c.min, c.max);
                if d > OUTLINE_DIST * k {
                    continue;
                }
                pass.set_vertex_buffer(0, buf.slice(..));
                pass.draw(0..*count, 0..1);
                draws += 1;
            }
            // line overlays (selection outline, constraint widget, ring, axes)
            for i in [2usize, 3, 4, 5] {
                let ov = &self.overlays[i];
                if ov.verts > 0 {
                    if let Some(v) = &ov.vbuf {
                        pass.set_vertex_buffer(0, v.slice(..));
                        pass.draw(0..ov.verts, 0..1);
                        draws += 1;
                    }
                }
            }
            // translucent quad overlays (ghost, selection fill)
            pass.set_pipeline(&self.pipe_overlay);
            for i in [0usize, 1] {
                let ov = &self.overlays[i];
                if ov.idx > 0 {
                    if let (Some(v), Some(idx)) = (&ov.vbuf, &ov.ibuf) {
                        pass.set_vertex_buffer(0, v.slice(..));
                        pass.set_index_buffer(idx.slice(..), wgpu::IndexFormat::Uint32);
                        pass.draw_indexed(0..ov.idx, 0, 0..1);
                        draws += 1;
                    }
                }
            }
            // stamp ghost (textured)
            let stamp = &self.overlays[6];
            if stamp.idx > 0 {
                pass.set_pipeline(&self.pipe_overlay_tex);
                if let (Some(v), Some(idx)) = (&stamp.vbuf, &stamp.ibuf) {
                    pass.set_vertex_buffer(0, v.slice(..));
                    pass.set_index_buffer(idx.slice(..), wgpu::IndexFormat::Uint32);
                    pass.draw_indexed(0..stamp.idx, 0, 0..1);
                    draws += 1;
                }
            }
            // player body
            let player = &self.overlays[7];
            if player.verts > 0 {
                pass.set_pipeline(&self.pipe_body);
                if let Some(v) = &player.vbuf {
                    pass.set_vertex_buffer(0, v.slice(..));
                    pass.draw(0..player.verts, 0..1);
                    draws += 1;
                }
            }
            if self.handles_count > 0 {
                if let Some(b) = &self.handles_buf {
                    pass.set_pipeline(&self.pipe_handles);
                    pass.set_vertex_buffer(0, b.slice(..));
                    pass.draw(0..6, 0..self.handles_count);
                    draws += 1;
                }
            }
        }
        self.queue.submit([enc.finish()]);
        self.queue.present(frame);
        self.last_draw_calls = draws;
    }

    // -- debug/test facade ---------------------------------------------------------

    pub fn painted_face_count(&self) -> u32 {
        self.chunks.values().map(|c| c.painted_faces).sum()
    }

    pub fn chunk_count(&self) -> u32 {
        self.chunks.len() as u32
    }

    pub fn region_count(&self) -> u32 {
        self.regions.len() as u32
    }

    pub fn pending(&self) -> u32 {
        (self.chunk_dirty.len() + self.region_dirty.len()) as u32
    }

    pub fn lod_counts(&self) -> [u32; 5] {
        let mut out = [0u32; 5];
        for c in self.chunks.values() {
            out[c.level as usize] += 1;
        }
        for r in self.regions.values() {
            out[r.level as usize] += 1;
        }
        out
    }
}
