class _R:
    def register(self, *a, **k):
        if a and callable(a[0]): return a[0]
        return lambda f: f
ARCH_REGISTRY = _R()
