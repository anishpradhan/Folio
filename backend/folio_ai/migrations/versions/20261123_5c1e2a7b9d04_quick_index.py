"""quick index: documents.index_kind, ingestion_jobs.kind

Revision ID: 5c1e2a7b9d04
Revises: abcd86a05a86
Create Date: 2026-11-23 10:00:00
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = '5c1e2a7b9d04'
down_revision: Union[str, None] = 'abcd86a05a86'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('documents', sa.Column('index_kind', sa.String(length=8), nullable=True))
    op.add_column('ingestion_jobs', sa.Column('kind', sa.String(length=8), server_default='full', nullable=False))
    # Everything prepared so far came from Docling.
    op.execute("UPDATE documents SET index_kind = 'full' WHERE status = 'ready'")


def downgrade() -> None:
    op.drop_column('ingestion_jobs', 'kind')
    op.drop_column('documents', 'index_kind')
