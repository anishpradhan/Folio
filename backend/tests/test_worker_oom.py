from folio_ai.ingestion.pipeline import IngestionError
from folio_ai.ingestion.worker import is_out_of_memory


def test_out_of_memory_is_recognised() -> None:
    assert is_out_of_memory(MemoryError())
    assert is_out_of_memory(RuntimeError("BFCArena::AllocateRawInternal Failed to allocate memory for requested buffer"))
    assert is_out_of_memory(OSError("The paging file is too small for this operation to complete. (os error 1455)"))
    assert not is_out_of_memory(RuntimeError("Gather node: index out of range"))
    assert not is_out_of_memory(IngestionError("No text was found in this PDF."))
