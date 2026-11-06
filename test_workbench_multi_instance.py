import unittest

from workbench_security import session_cookie, valid_token


class PortScopedSessionTests(unittest.TestCase):
    def test_parallel_ports_and_legacy_session_coexist(self):
        cookies = "; ".join([
            session_cookie("production").split(";", 1)[0],
            session_cookie("development", 8791).split(";", 1)[0],
            session_cookie("another", 8792).split(";", 1)[0],
        ])
        headers = {"Cookie": cookies}
        self.assertTrue(valid_token(headers, "production"))
        self.assertTrue(valid_token(headers, "development", 8791))
        self.assertTrue(valid_token(headers, "another", 8792))
        self.assertFalse(valid_token(headers, "development", 8792))
        self.assertFalse(valid_token(headers, "production", 8791))

    def test_port_cookie_retains_http_only_and_same_site_flags(self):
        cookie = session_cookie("test-token", 8791)
        self.assertTrue(cookie.startswith("h3_session_8791=test-token;"))
        self.assertIn("HttpOnly", cookie)
        self.assertIn("SameSite=Strict", cookie)

    def test_explicit_agent_token_works_without_browser_cookies(self):
        self.assertTrue(valid_token({"X-H3-Token": "agent"}, "agent", 8791))
        self.assertFalse(valid_token({"Cookie": "h3_session=agent"}, "agent", 8791))


if __name__ == "__main__":
    unittest.main()
