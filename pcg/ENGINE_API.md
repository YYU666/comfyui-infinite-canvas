# M2 engine API (stdlib, in-memory only)

`pcg_geometry.evaluate(operation, parameters, inputs)` accepts the short name or `refmuse.pcg.` prefix and returns the named outputs below. Unknown keys/ports fail. `pcg_geometry.validate_geometry(value)` returns the validated value. `pcg_geometry.summarize(value)` returns bounded counts/bounds/domain metadata and at most 64 position/instance samples. `pcg_export.export_glb(value)` returns GLB bytes; no engine function reads/writes files or accepts paths.

Geometry values have `contractVersion:1`. Mesh: `type:'Mesh',positions:vector3[],triangles:integer3[],normals:vector3[],uvs:vector2[]`; normals and UVs are empty or exactly three entries per triangle (Corner domain). PointSet: `type:'PointSet',positions:vector3[]`. InstanceSet: `type:'InstanceSet',prototype:Mesh,instances:[{id:string,translation:vector3,rotation:quaternionXYZW,scale:vector3}]`; IDs unique, transforms nonzero scale, unit quaternion. Values are meters, right handed, Y up. Geometry content/topology IDs are SHA256 canonical JSON; topology includes indexed connectivity and counts. Fields and selections bind both IDs and a domain; any source change invalidates the binding.

Limits: 100000 triangles, 60000 mesh vertices, 10000 points, 10000 instances, 32 MiB canonical JSON per value; 64 summary samples. Before subdivision/join/realization budgets are checked before allocating output. Image: `{contractVersion:1,type:'Image',width:int,height:int,pixels:[vector3]}` with width/height 1..1024, max 1048576 RGB pixels in [0,1]. In-memory managed inputs only.

All inputs and outputs are required unless marked `?`. `Geometry` is Mesh|PointSet|InstanceSet. Numeric bounds below are inclusive; vector components finite bounded. Empty parameter objects use defaults. No additional properties.

| operation | input ports | output ports | parameters/defaults |
|---|---|---|---|
| primitive | - | geometry:Geometry | kind enum box/sphere/cylinder/plane='box'; size vector3=[1,1,1]; subdivisions int0..6=0 |
| transform | geometry:Geometry | geometry:Geometry | translation vector3=[0,0,0]; rotation vector3 Euler radians=[0,0,0]; scale vector3=[1,1,1] (nonzero) |
| join_geometry | a:Geometry,b:Geometry | geometry:Geometry | none; same types Mesh or PointSet only |
| subdivide | geometry:Geometry | geometry:Geometry | levels int0..6=1; Mesh only |
| attribute_read | geometry:Geometry | field:Field | name enum position/normal='position'; position Point, normal Corner |
| noise_field | geometry:Geometry,position:Field? | field:Field | seed int0..2147483647=0; amplitude number0..1000=.1; frequency number.0001..1000=1; output enum scalar/vector3=vector3 |
| field_math | a:Field,b:Field? | field:Field | operation enum add/multiply/component_x/component_y/component_z/length/normalize='multiply'; value number[-1000,1000]=1 |
| compare | field:Field | selection:Selection | operation enum greater/less/equal='greater'; value number[-1e12,1e12]=0; scalar fields only |
| selection | geometry:Geometry,a:Selection?,b:Selection? | selection:Selection | domain enum Point/Face/Corner/Instance/Detail='Point'; mode enum all/none/every_n/and/or/not='all'; every int1..10000=2 |
| set_position | geometry:Geometry,offset:Field,selection:Selection? | geometry:Geometry | none; Mesh or PointSet, Point vector3 offset |
| recompute_normals | geometry:Geometry | geometry:Geometry | mode enum flat/smooth='smooth'; Mesh only |
| sample_texture | geometry:Geometry,image:Image? | field:Field | interpolation enum nearest/bilinear='bilinear'; mapping enum uv/xy/xz/yz='uv'; channel enum rgb/r/g/b='rgb'; color vector3=[.5,.5,.5] in [0,1] supplies explicit constant 1x1 texture when image absent; UV => Corner, projection => Point; coordinates clamped to [0,1] |
| scatter_points | geometry:Geometry | points:Geometry | count int0..10000=100; seed int0..2147483647=0; minDistance number0..1e6=0; maxSlope number0..90=90 degrees from +Y; minHeight number[-1e6,1e6]=-1e6; maxHeight number[-1e6,1e6]=1e6; area-weighted triangle sampling |
| instance_on_points | points:Geometry,prototype:Geometry | instances:Geometry | scale vector3=[1,1,1] nonzero; PointSet + Mesh |
| instance_transform | instances:Geometry | instances:Geometry | translation/rotation/scale as transform; InstanceSet only |
| realize_instances | instances:Geometry | geometry:Geometry | none |
| inspect_geometry | geometry:Geometry | report:DiagnosticReport,geometry:Geometry | none; report is summarize output |
| publish_geometry | geometry:Geometry | geometry:Geometry | none; validated copy, host publishes GLB and artifact identity |

Entry recipes use the evaluator above: shape(kind,size,subdivisions); rock(seed,subdivisions=2,size=[1,1,1],roughness=.2); scatter(count=100,seed=0,scale=[1,1,1],minDistance=0,maxSlope=90,minHeight=-1e6,maxHeight=1e6) inputs geometry Mesh,prototype Mesh; compose no parameters inputs a,b. game_asset unavailable in M2. Rock uses sphere -> attribute_read(position) + noise_field(scalar) -> field_math(multiply) -> set_position -> recompute_normals. Positive radial scale keeps the closed surface orientation across all seeds. Field payload: `{contractVersion:1,type:'Field'|'Selection',binding:{contentHash,topologyHash},domain,valueType,values}`; Selection valueType boolean. Domains are actual Point/Face/Corner/Instance/Detail with exact count. Numeric fields may be combined only with identical binding/domain/count; scalar/vector3 arithmetic broadcasts the scalar. Corner fields cannot drive set_position.

`pcg_geometry.validate_value(value, geometry=None)` validates internal Geometry, Field, Selection, Image, or bounded DiagnosticReport output. Field helpers `pcg_fields.binding`, `validate_field(value, geometry=None)`, `validate_image` are public. Vector field math components/length return float, normalize returns vector3; add/multiply return vector3 if either operand is vector3 (scalar broadcast), otherwise float. Selection and/or require a,b; not requires a. Instance parent transforms currently require uniform scale to avoid silently discarding shear. Scatter filters face slope from +Y, samples Y height range, and uses a spatial grid to enforce Euclidean minDistance. Up to max(1000,count*100) attempts (at most one million) are deterministic; insufficient surfaces/packing raise INSUFFICIENT_PLACEMENT without a partial result. Prototype collision bounds are deferred.

InstanceSet summary bounds are explicitly `boundsKind:conservative` (transformed prototype AABB corners); Mesh/PointSet bounds are exact. This avoids expanding instances during inspection. GLB output keeps shared meshes. Float32 export precision collapse is rejected as EXPORT_PRECISION_LOSS.
