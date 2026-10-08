"""retarget: animations made for one skeletal mesh played by another. It makes (or reuses) an IK Rig
for each mesh with Unreal's auto-characterisation (it knows the UE4 and UE5 mannequins, Mixamo, CC4,
Rigify and some twenty other skeletons), an IK Retargeter between them with chains mapped by name,
then copies the clips onto the target in `dest`. Answers the new clips; a skeleton Unreal can't
characterise is an error naming which mesh."""

import time

import unreal

from genex_build import imports
from genex_loop import editor, paths
from genex_loop.errors import Refused

RIG_FOLDER = '/Game/GX/Retarget'
MAX_ANIMATIONS = 64

MESSAGE = {
    'mesh': '{field} must be an existing SkeletalMesh asset.',
    'animations': f'animations must be 1 to {MAX_ANIMATIONS} AnimSequence (or AnimMontage) asset paths.',
    'chains': ('Unreal found no retarget chains on {mesh}: its skeleton isn\'t one auto-characterisation knows. '
               'Play its own clips, or retarget in the editor.'),
    'made': 'Unreal did not make {path}.',
    'nothing': 'The retarget made no clips; see the editor log.',
}


def _mesh(path: object, field: str) -> unreal.SkeletalMesh:
    loaded = unreal.load_asset(path) if isinstance(path, str) and path.startswith(('/Game/', '/Engine/')) else None
    if not isinstance(loaded, unreal.SkeletalMesh):
        raise Refused(MESSAGE['mesh'].format(field=field), **{field: path})
    return loaded


def _clips(animations: object) -> list:
    if not isinstance(animations, (list, tuple)) or not 0 < len(animations) <= MAX_ANIMATIONS:
        raise Refused(MESSAGE['animations'])
    found = []
    for path in animations:
        loaded = unreal.load_asset(path) if isinstance(path, str) and path.startswith(('/Game/', '/Engine/')) else None
        if not isinstance(loaded, unreal.AnimSequenceBase):
            raise Refused(MESSAGE['animations'], animation=path)
        found.append(unreal.EditorAssetLibrary.find_asset_data(path))
    return found


def _asset(name: str, cls, factory):
    path = f'{RIG_FOLDER}/{name}'
    if unreal.EditorAssetLibrary.does_asset_exist(path):
        existing = unreal.load_asset(path)
        if isinstance(existing, cls):
            return existing
    made = unreal.AssetToolsHelpers.get_asset_tools().create_asset(name, RIG_FOLDER, cls, factory)
    if not isinstance(made, cls):
        raise Refused(MESSAGE['made'].format(path=path))
    return made


def ik_rig(mesh: unreal.SkeletalMesh) -> unreal.IKRigDefinition:
    """The auto-characterised IK Rig IK_<mesh name>, made or refreshed."""
    rig = _asset(f'IK_{mesh.get_name()}', unreal.IKRigDefinition, unreal.IKRigDefinitionFactory())
    controller = unreal.IKRigController.get_controller(rig)
    controller.set_skeletal_mesh(mesh)
    controller.apply_auto_generated_retarget_definition()
    if not controller.get_retarget_chains():
        raise Refused(MESSAGE['chains'].format(mesh=mesh.get_path_name().split('.')[0]))
    return rig


def retargeter(source: unreal.SkeletalMesh, target: unreal.SkeletalMesh) -> unreal.IKRetargeter:
    """The IK Retargeter RTG_<source>_to_<target> between their rigs, chains mapped by name."""
    asset = _asset(f'RTG_{source.get_name()}_to_{target.get_name()}', unreal.IKRetargeter, unreal.IKRetargetFactory())
    controller = unreal.IKRetargeterController.get_controller(asset)
    controller.set_ik_rig(unreal.RetargetSourceOrTarget.SOURCE, ik_rig(source))
    controller.set_ik_rig(unreal.RetargetSourceOrTarget.TARGET, ik_rig(target))
    if controller.get_num_retarget_ops() == 0:
        controller.add_default_ops()
    controller.auto_map_chains(unreal.AutoMapChainType.FUZZY, True)
    controller.auto_align_all_bones(unreal.RetargetSourceOrTarget.TARGET, unreal.RetargetAutoAlignMethod.CHAIN_TO_CHAIN)
    unreal.EditorAssetLibrary.save_loaded_asset(asset, False)
    return asset


def retarget(source_mesh: str, target_mesh: str, animations: list, dest: str) -> dict:
    """Copies `animations` (made for source_mesh) onto target_mesh, into `dest`; {animations, retargeter, ms}."""
    imports.refuse_during_play()
    source, target = _mesh(source_mesh, 'source_mesh'), _mesh(target_mesh, 'target_mesh')
    clips = _clips(animations)
    paths.check_content_path(dest)
    started = time.perf_counter()
    asset = retargeter(source, target)
    inputs = unreal.IKRetargetBatchOperationInputs()
    for key, value in {'assets_to_retarget': clips, 'source_mesh': source, 'target_mesh': target,
                       'ik_retarget_asset': asset, 'target_path': dest, 'suffix': f'_{target.get_name()}',
                       'include_referenced_assets': False, 'overwrite_existing_files': True}.items():
        inputs.set_editor_property(key, value)
    made = unreal.IKRetargetBatchOperation.run_batch_retarget(inputs)
    if not made:
        raise Refused(MESSAGE['nothing'])
    return {'animations': sorted(str(data.package_name) for data in made),
            'retargeter': asset.get_path_name().split('.')[0], 'ms': editor.elapsed_ms(started)}
