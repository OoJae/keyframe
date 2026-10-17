# Deployments

`script/Deploy.s.sol` writes `<chainid>.json` here after a real broadcast (never on a dry run):
`factory`, `vaultImpl`, `usdc`, `seller`, `create2Deployer`, `salt`, `initCodeHash`, `factoryRuntimeCodeHash`,
`vaultImplRuntimeCodeHash`, `compiler`, `block`. Anvil-fork rehearsals go to `local/` (gitignored), because they use throwaway
sellers. No mainnet deployment has been made from this repository yet.
