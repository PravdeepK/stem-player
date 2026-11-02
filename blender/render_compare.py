# Renders the exported GLB at the reference photos' camera angles.
#
#   blender -b -P blender/render_compare.py -- <output dir> [view ...]
#
# Works on the .glb rather than the build scene, so it also proves the export.

import math
import os
import sys

import bpy
from mathutils import Matrix, Vector

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GLB = os.path.join(REPO, "assets", "models", "stem-player.glb")

argv = sys.argv[sys.argv.index("--") + 1:]
OUT = argv[0]
ONLY = set(argv[1:])

# az/el in degrees; cx/cy = where the device centre lands in the frame (0..1);
# width_frac = device width as a fraction of the frame.
VIEWS = {
    "ref06": dict(az=-37.5, el=36.2, cx=0.4785, cy=0.467, width_frac=0.252, key=(150, 58), res=(2364, 1330), ground=(0.86, 0.86, 0.82), led=False),
    "ref07": dict(az=70, el=41.0, cx=0.4956, cy=0.536, width_frac=0.2593, key=(160, 62), res=(2364, 1330), ground=(0.58, 0.59, 0.58), led=True, exposure=-1.25),
    "top": dict(az=-90, el=90, cx=0.5, cy=0.5, width_frac=0.96, res=(900, 900), ground=(0.1, 0.1, 0.1), led=True),
    "close": dict(az=-37.5, el=52, cx=0.5, cy=0.47, width_frac=0.85, res=(1100, 800), ground=(0.86, 0.86, 0.82), led=False),
    "fcc_top": dict(az=-90, el=89.9, cx=0.496, cy=0.503, width_frac=0.935, res=(960, 960), ground=(0.02, 0.18, 0.62), led=False, key=(180, 72), exposure=-0.9, lens=150.0),
    "turn_se": dict(az=-45, el=28, cx=0.5, cy=0.5, width_frac=0.62, res=(1000, 700), ground=(0.82, 0.82, 0.8), led=False),
    "turn_ne": dict(az=45, el=28, cx=0.5, cy=0.5, width_frac=0.62, res=(1000, 700), ground=(0.82, 0.82, 0.8), led=False),
    "turn_nw": dict(az=135, el=28, cx=0.5, cy=0.5, width_frac=0.62, res=(1000, 700), ground=(0.82, 0.82, 0.8), led=False),
    "turn_sw": dict(az=225, el=28, cx=0.5, cy=0.5, width_frac=0.62, res=(1000, 700), ground=(0.82, 0.82, 0.8), led=False),
    "back": dict(az=-100, el=-48, cx=0.5, cy=0.5, width_frac=0.62, res=(1000, 700), ground=None, led=False),
    "back_flat": dict(az=-135, el=-90, cx=0.5, cy=0.5, width_frac=0.8, res=(900, 900), ground=None, led=False, up=(0.7071, 0.7071, 0)),
    "press": dict(az=-55, el=20, cx=0.45, cy=0.3, width_frac=1.0, res=(1000, 700), ground=None, led=False, press=0.001),
    "side": dict(az=-45, el=0, cx=0.5, cy=0.5, width_frac=0.62, res=(1000, 700), ground=None, led=False),
}
LENS = 50.0
SENSOR = 36.0
LED_COLOR = (1.0, 0.09, 0.03)


def setup():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=GLB)
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    prefs = bpy.context.preferences.addons["cycles"].preferences
    prefs.compute_device_type = "METAL"
    prefs.get_devices()
    for device in prefs.devices:
        device.use = True
    scene.cycles.device = "GPU"
    scene.cycles.samples = 64
    scene.cycles.use_denoising = True
    scene.view_settings.view_transform = "Standard"
    scene.view_settings.look = "None"

    world = bpy.data.worlds.new("World")
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs[0].default_value = (1, 1, 1, 1)
    world.node_tree.nodes["Background"].inputs[1].default_value = 0.30
    scene.world = world

    bpy.ops.mesh.primitive_plane_add(size=4.0, location=(0, 0, -0.0159))
    ground = bpy.context.object
    ground.name = "ground"
    mat = bpy.data.materials.new("ground")
    mat.use_nodes = True
    ground.data.materials.append(mat)

    bpy.ops.object.light_add(type="AREA", location=(0.14, -0.05, 0.34))
    key = bpy.context.object
    key.data.size = 0.42
    key.data.energy = 2.4
    key.rotation_euler = (0.2, 0.42, 0)

    cam = bpy.data.cameras.new("cam")
    cam.lens = LENS
    cam.sensor_width = SENSOR
    cam.clip_start = 0.005
    cam_obj = bpy.data.objects.new("cam", cam)
    scene.collection.objects.link(cam_obj)
    scene.camera = cam_obj
    scene["key_light"] = key.name
    return scene, cam_obj, ground, mat


def led_material():
    mat = bpy.data.materials.new("led_on")
    mat.use_nodes = True
    nodes, links = mat.node_tree.nodes, mat.node_tree.links
    nodes.clear()
    out = nodes.new("ShaderNodeOutputMaterial")
    add = nodes.new("ShaderNodeMixShader")
    trans = nodes.new("ShaderNodeBsdfTransparent")
    emit = nodes.new("ShaderNodeEmission")
    emit.inputs["Color"].default_value = (*LED_COLOR, 1)
    emit.inputs["Strength"].default_value = 5.0
    tex = nodes.new("ShaderNodeTexCoord")
    grad = nodes.new("ShaderNodeTexGradient")
    grad.gradient_type = "SPHERICAL"
    mapping = nodes.new("ShaderNodeMapping")
    mapping.inputs["Location"].default_value = (0.5, 0.5, 0)
    mapping.inputs["Scale"].default_value = (2, 2, 1)
    links.new(tex.outputs["UV"], mapping.inputs["Vector"])
    fix = nodes.new("ShaderNodeVectorMath")
    fix.operation = "SUBTRACT"
    fix.inputs[1].default_value = (0.5, 0.5, 0)
    links.new(tex.outputs["UV"], fix.inputs[0])
    scale = nodes.new("ShaderNodeVectorMath")
    scale.operation = "SCALE"
    scale.inputs["Scale"].default_value = 2.0
    links.new(fix.outputs[0], scale.inputs[0])
    links.new(scale.outputs[0], grad.inputs["Vector"])
    power = nodes.new("ShaderNodeMath")
    power.operation = "POWER"
    power.inputs[1].default_value = 2.6
    links.new(grad.outputs["Fac"], power.inputs[0])
    links.new(power.outputs[0], add.inputs[0])
    links.new(trans.outputs[0], add.inputs[1])
    links.new(emit.outputs[0], add.inputs[2])
    links.new(add.outputs[0], out.inputs["Surface"])
    mat.surface_render_method = "BLENDED"
    return mat


def render(scene, cam_obj, ground, ground_mat, led_on, led_off, name, v):
    az, el = math.radians(v["az"]), math.radians(v["el"])
    w, h = v["res"]
    scene.render.resolution_x, scene.render.resolution_y = w, h
    scene.render.resolution_percentage = int(os.environ.get("RES_PCT", "100"))
    # Distance that makes the 70 mm device span width_frac of the frame.
    lens = v.get("lens", LENS)
    cam_obj.data.lens = lens
    dist = 0.070 * (lens / SENSOR) / v["width_frac"]
    d = Vector((math.cos(el) * math.cos(az), math.cos(el) * math.sin(az), math.sin(el)))
    cam_obj.location = d * dist
    hint = Vector(v.get("up", (0, 0, 1) if abs(v["el"]) < 85 else (0, 1, 0)))
    forward = -d
    right = forward.cross(hint).normalized()
    true_up = right.cross(forward).normalized()
    cam_obj.rotation_euler = Matrix((right, true_up, -forward)).transposed().to_euler()
    cam_obj.data.shift_x = 0.5 - v["cx"]
    cam_obj.data.shift_y = (v["cy"] - 0.5) * h / w

    # Soft key from behind and above the subject, as in the photos.
    key = bpy.data.objects[scene["key_light"]]
    key_az, key_el = v.get("key", (150, 55))
    kaz, kel = math.radians(v["az"] + key_az), math.radians(key_el)
    kdir = Vector((math.cos(kel) * math.cos(kaz), math.cos(kel) * math.sin(kaz), math.sin(kel)))
    key.location = kdir * 0.42
    key.rotation_euler = (-kdir).to_track_quat("-Z", "Y").to_euler()

    if v["ground"] is None:
        ground.hide_render = True
    else:
        ground.hide_render = False
        ground_mat.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (*v["ground"], 1)
        ground_mat.node_tree.nodes["Principled BSDF"].inputs["Roughness"].default_value = 0.55

    for obj in bpy.data.objects:
        if obj.name.startswith("LED_"):
            obj.hide_render = not v["led"]
            obj.data.materials[0] = led_on
        if obj.name.startswith("Hit_"):
            obj.hide_render = True

    # Optional press test: slide every button inwards along its own normal.
    for obj in bpy.data.objects:
        if obj.name.startswith("Btn_"):
            if "rest" not in obj:
                obj["rest"] = list(obj.location)
            inward = obj.matrix_world.to_3x3().normalized() @ Vector((0, 0, -1))
            obj.location = Vector(obj["rest"]) + inward * v.get("press", 0.0)

    scene.view_settings.exposure = v.get("exposure", -0.2)
    scene.render.filepath = os.path.join(OUT, f"{name}.png")
    bpy.ops.render.render(write_still=True)


def main():
    os.makedirs(OUT, exist_ok=True)
    scene, cam_obj, ground, ground_mat = setup()
    led_on = led_material()
    for name, view in VIEWS.items():
        if ONLY and name not in ONLY:
            continue
        render(scene, cam_obj, ground, ground_mat, led_on, None, name, view)
    print("[render] done")


main()
