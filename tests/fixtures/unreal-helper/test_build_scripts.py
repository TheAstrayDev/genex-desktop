"""run_script (genex_build.tools.GenexBuildTools) runs one of the game's build scripts,
unreal/build/<file>.py, in the open editor with `unreal`, the `gx` library and `args`, in one undo
step and its own scope, so running it twice leaves one copy of what it builds. A file that is not a
plain .py of at most 256 KB in unreal/build/ (a path climbing out, a full path elsewhere, a link out,
another kind of file, too large) is refused with nothing run and nothing in the editor changed: no
transaction, no actor. A failing script answers the file and line it failed on."""

import json
import os
import unittest
from unittest import mock

import unreal
from unreal import Vector

from genex_build import scripts
from genex_build.tools import GenexBuildTools

from support import HelperCase

BOX = '/Game/Kit/SM_Box'
SPAWN_THREE = (
    'for i in range(3):\n'
    f'    gx.spawn_mesh("{BOX}", (i * 100, 0, 0), label=f"Box{{i}}")\n'
    'result = len(gx.actors("kit"))\n'
)


def tool(name: str, *args) -> dict:
    return json.loads(getattr(GenexBuildTools, name)(*args))


class ScriptCase(HelperCase):
    """A game folder with unreal/build/ and a static mesh the scripts place."""

    def setUp(self) -> None:
        super().setUp()
        self.build = self.path('game', 'unreal', 'build')
        unreal.state['loaded'][BOX] = unreal.StaticMesh(Vector(-50, -50, 0), Vector(50, 50, 100))

    def script(self, name: str, text: str) -> str:
        return self.write(os.path.join(self.build, name), text)

    def run_script(self, file: str, args: str = '') -> dict:
        return tool('run_script', file, args)


class Refuses(ScriptCase):
    def test_refuses_files_that_are_not_a_plain_script_in_unreal_build_without_running_anything(self) -> None:
        marker_script = f'open({self.marker!r}, "w").write("ran")\n'
        self.script('kit.py', marker_script)
        outside = self.write(os.path.join(self.outside, 'evil.py'), marker_script)
        self.write(os.path.join(self.game, 'top.py'), marker_script)
        os.symlink(outside, os.path.join(self.build, 'linked.py'))
        os.symlink(self.outside, os.path.join(self.build, 'linked_dir'))
        self.script('notes.txt', 'hi')
        self.script('kit.py.txt', marker_script)
        os.makedirs(os.path.join(self.build, 'folder.py'))
        self.script('huge.py', '#' * (256 * 1024 + 1))
        files = {
            'climbing out': '../top.py',
            'climbing out of a folder': 'zones/../../top.py',
            'a full path elsewhere': outside,
            'a full path climbing out': os.path.join(self.build, '..', '..', 'top.py'),
            'a link to a file outside': 'linked.py',
            'through a linked folder': 'linked_dir/evil.py',
            'not a script': 'notes.txt',
            'a script name with more after it': 'kit.py.txt',
            'a folder': 'folder.py',
            'too large': 'huge.py',
            'missing': 'nope.py',
            'empty': '',
            'a backslash': 'zones\\kit.py',
            'a NUL': 'kit.py\0',
            'an asset path': '/Game/kit.py',
            'a name starting with a dash': '-kit.py',
            'not text': 42,
        }
        for label, file in files.items():
            with self.subTest(label):
                self.fresh()
                result = self.run_script(file)
                self.assert_refused(result)

    def test_refuses_arguments_that_are_not_a_json_object(self) -> None:
        self.script('kit.py', f'open({self.marker!r}, "w").write("ran")\n')
        for args in ('[1, 2]', 'not json', '{"a": NaN}', '"text"', '{"a": 1}' + ' ' * 70000):
            with self.subTest(args=args[:20]):
                self.fresh()
                self.assert_refused(self.run_script('kit.py', args))

    def test_refused_during_play_and_outside_a_game_folder(self) -> None:
        self.script('kit.py', f'open({self.marker!r}, "w").write("ran")\n')
        unreal.state['pie'] = True
        self.assert_refused(self.run_script('kit.py'))
        unreal.reset(self.path('elsewhere', 'Drift'))
        self.assert_refused(self.run_script('kit.py'))


class Runs(ScriptCase):
    def test_a_script_gets_unreal_gx_and_its_args_and_answers_its_output_and_result_in_one_undo_step(self) -> None:
        self.script('zones/shaft.py', 'print("levels", args["levels"])\nresult = {"twice": args["levels"] * 2, "gx": gx.__name__}\n')
        result = self.run_script('zones/shaft.py', '{"levels": 4}')
        self.assertTrue(result['ok'], result)
        self.assertEqual(result['script'], os.path.join('zones', 'shaft.py'))
        self.assertIn('levels 4', result['output'])
        self.assertEqual(result['result'], {'twice': 8, 'gx': 'genex_build.gx'})
        self.assertEqual([c for c in unreal.calls if c[0] == 'transaction'], [('transaction', 'Genex build zones/shaft')])
        self.assertEqual(result['scopes'], {'zones/shaft': {'removed': 0, 'made': 0}})

    def test_the_same_script_given_as_unreal_build_or_its_full_path_runs_too(self) -> None:
        full = self.script('kit.py', 'result = 1\n')
        for file in ('unreal/build/kit.py', 'build/kit.py', full):
            with self.subTest(file=file):
                self.assertEqual(self.run_script(file)['result'], 1)

    def test_running_a_script_twice_leaves_one_copy_of_what_it_made(self) -> None:
        self.script('kit.py', SPAWN_THREE)
        first = self.run_script('kit.py')
        self.assertEqual((first['ok'], first['result']), (True, 3), first)
        self.assertEqual(first['scopes'], {'kit': {'removed': 0, 'made': 3}})
        count = len(unreal.state['actors'])
        second = self.run_script('kit.py')
        self.assertEqual(second['scopes'], {'kit': {'removed': 3, 'made': 3}})
        self.assertEqual(len(unreal.state['actors']), count)
        boxes = [a for a in unreal.state['actors'] if 'gx:kit' in [str(t) for t in a.tags]]
        self.assertEqual(sorted(a.get_actor_label() for a in boxes), ['Box0', 'Box1', 'Box2'])
        self.assertEqual({a.folder for a in boxes}, {'GX/kit'})

    def test_named_scopes_replace_only_their_own_actors(self) -> None:
        self.script('two.py', (
            f'gx.scope("walls")\ngx.spawn_mesh("{BOX}", (0, 0, 0))\n'
            f'with gx.scope("lamps"):\n    gx.spawn_mesh("{BOX}", (0, 100, 0))\n    gx.spawn_mesh("{BOX}", (0, 200, 0))\n'
            f'gx.spawn_mesh("{BOX}", (0, 300, 0))\n'))
        self.script('kit.py', SPAWN_THREE)
        self.run_script('kit.py')
        first = self.run_script('two.py')
        self.assertEqual(first['scopes'], {'two': {'removed': 0, 'made': 0}, 'walls': {'removed': 0, 'made': 2},
                                           'lamps': {'removed': 0, 'made': 2}})
        second = self.run_script('two.py')
        self.assertEqual(second['scopes']['walls'], {'removed': 2, 'made': 2})
        self.assertEqual(second['scopes']['lamps'], {'removed': 2, 'made': 2})
        self.assertEqual(len([a for a in unreal.state['actors'] if 'gx:kit' in [str(t) for t in a.tags]]), 3,
                         'another script\'s scope is left alone')

    def test_a_failing_script_answers_its_file_and_line_and_keeps_what_it_made(self) -> None:
        self.script('kit.py', f'gx.spawn_mesh("{BOX}", (0, 0, 0))\nx = 1\nx = x / 0\n')
        result = self.run_script('kit.py')
        self.assertFalse(result['ok'])
        self.assertEqual((result['where'], result['line']), ('kit.py:3', 'x = x / 0'))
        self.assertIn('ZeroDivisionError', result['error'])
        self.assertEqual(result['scopes'], {'kit': {'removed': 0, 'made': 1}})

    def test_an_error_in_a_module_the_script_imports_names_that_module_and_modules_import_fresh(self) -> None:
        self.script('helpers/numbers.py', 'VALUE = 1\n')
        self.script('helpers/__init__.py', '')
        self.script('kit.py', 'from helpers import numbers\nresult = numbers.VALUE\n')
        self.assertEqual(self.run_script('kit.py')['result'], 1)
        self.script('helpers/numbers.py', 'VALUE = 2\n')
        self.assertEqual(self.run_script('kit.py')['result'], 2, 'the edited module is loaded again')
        self.script('helpers/numbers.py', 'VALUE = undefined_name\n')
        failed = self.run_script('kit.py')
        self.assertEqual(failed['where'], os.path.join('helpers', 'numbers.py') + ':1')

    def test_a_syntax_error_answers_where_and_changes_nothing(self) -> None:
        self.script('kit.py', 'x = 1\nif x\n')
        result = self.run_script('kit.py')
        self.assertFalse(result['ok'])
        self.assertEqual(result['where'], 'kit.py:2')
        self.assertEqual(unreal.calls, [], 'no undo step and no actor for a script that never ran')

    def test_a_script_past_its_time_is_stopped_even_inside_its_own_try(self) -> None:
        self.script('kit.py', 'while True:\n    try:\n        pass\n    except Exception:\n        pass\n')
        with mock.patch.object(scripts, 'SCRIPT_TIMEOUT_S', 0.2):
            result = self.run_script('kit.py')
        self.assertFalse(result['ok'])
        self.assertIn('ran past', result['error'])
        self.assertTrue(result['where'].startswith('kit.py:'), result['where'])


if __name__ == '__main__':
    unittest.main()


class NavMeshBoundsVolume(unreal.Actor):
    """Unreal's navigation bounds (its class name is all run_script reads)."""


class Navigation(ScriptCase):
    """A script that remakes floors leaves the level's nav mesh stale, and every AI stands idle: run_script
    rebuilds navigation after a run that changed the level, when the level has navigation bounds."""

    @staticmethod
    def rebuilds() -> int:
        return len([c for c in unreal.calls if c[0] == 'console' and 'RebuildNavigation' in c[1]])

    def test_a_run_that_changes_a_level_with_navigation_rebuilds_it(self) -> None:
        unreal.state['actors'] = [NavMeshBoundsVolume('NavBounds')]
        self.script('kit.py', SPAWN_THREE)
        result = self.run_script('kit.py')
        self.assertEqual(result['navigation'], 'rebuilt', result)
        self.assertEqual(self.rebuilds(), 1)

    def test_nothing_is_rebuilt_without_navigation_bounds_or_a_change(self) -> None:
        self.script('kit.py', SPAWN_THREE)
        self.assertNotIn('navigation', self.run_script('kit.py'))
        unreal.state['actors'].append(NavMeshBoundsVolume('NavBounds'))
        self.script('query.py', 'result = len(gx.actors("kit"))\n')
        self.assertNotIn('navigation', self.run_script('query.py'))
        self.assertEqual(self.rebuilds(), 0)
