import React from 'react';
import { useOvermind } from 'app/overmind';
import { sandboxesTypes } from 'app/overmind/namespaces/dashboard/state';
import { Header } from 'app/pages/NewDashboard/Components/Header';
import {
  VariableGrid,
  SkeletonGrid,
} from 'app/pages/NewDashboard/Components/VariableGrid';
import { SelectionProvider } from 'app/pages/NewDashboard/Components/Selection';
import { getPossibleTemplates } from '../../utils';
import { useBottomScroll } from './useBottomScroll';

export const Drafts = () => {
  const {
    actions,
    state: {
      dashboard: { sandboxes },
    },
  } = useOvermind();
  const [visibleSandboxes] = useBottomScroll('DRAFTS');

  React.useEffect(() => {
    actions.dashboard.getPage(sandboxesTypes.DRAFTS);
  }, [actions.dashboard]);

  return (
    <SelectionProvider sandboxes={visibleSandboxes}>
      <Header
        path="Drafts"
        templates={getPossibleTemplates(sandboxes.DRAFTS)}
      />
      {sandboxes.DRAFTS ? (
        <VariableGrid
          items={visibleSandboxes.map(sandbox => ({
            type: 'sandbox',
            ...sandbox,
          }))}
        />
      ) : (
        <SkeletonGrid count={8} />
      )}
    </SelectionProvider>
  );
};
