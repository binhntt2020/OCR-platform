from typing import List


def postprocess_texts(texts: List[str]) -> List[str]:
    # TODO: spell correction, normalization, domain dictionaries
    return [t.strip() for t in texts]
