"""The public download helper must fail closed before any network or file write."""
import os
from pathlib import Path
import runpy
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]

class AssetPolicyTests(unittest.TestCase):
    def test_feiyu_requires_explicit_asset_opt_in_before_network(self):
        module = runpy.run_path(str(ROOT / 'Luna-Discord-Bot-Full-Docker/FeiyuTTS/download.py'))
        with tempfile.TemporaryDirectory() as directory:
            with patch.dict(os.environ, {}, clear=True), patch('urllib.request.urlopen') as request:
                with self.assertRaises(PermissionError):
                    module['download'](str(Path(directory) / 'assets'))
                request.assert_not_called()
                self.assertEqual(list(Path(directory).iterdir()), [])

if __name__ == '__main__':
    unittest.main()
