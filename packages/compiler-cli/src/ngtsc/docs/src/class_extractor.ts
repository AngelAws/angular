/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import ts from 'typescript';

import {Reference} from '../../imports';
import {DirectiveMeta, InputMapping, InputOrOutput, MetadataReader, NgModuleMeta, PipeMeta} from '../../metadata';
import {ClassDeclaration} from '../../reflection';

import {ClassEntry, DirectiveEntry, EntryType, InterfaceEntry, MemberEntry, MemberTags, MemberType, MethodEntry, PipeEntry, PropertyEntry} from './entities';
import {isAngularPrivateName} from './filters';
import {FunctionExtractor} from './function_extractor';
import {extractGenerics} from './generics_extractor';
import {extractJsDocDescription, extractJsDocTags, extractRawJsDoc} from './jsdoc_extractor';
import {extractResolvedTypeString} from './type_extractor';

// For the purpose of extraction, we can largely treat properties and accessors the same.

/** A class member declaration that is *like* a property (including accessors) */
type PropertyDeclarationLike = ts.PropertyDeclaration|ts.AccessorDeclaration;

// For the purposes of extraction, we can treat interfaces as identical to classes
// with a couple of shorthand types to normalize over the differences between them.

/** Type representing either a class declaration ro an interface declaration. */
type ClassDeclarationLike = ts.ClassDeclaration|ts.InterfaceDeclaration;

/** Type representing either a class member node or an interface member node. */
type MemberElement = ts.ClassElement|ts.TypeElement;

/** Type representing either a class method declaration or an interface method signature. */
type MethodLike = ts.MethodDeclaration|ts.MethodSignature;

/** Type representing either a class property declaration or an interface property signature. */
type PropertyLike = PropertyDeclarationLike|ts.PropertySignature;

/** Extractor to pull info for API reference documentation for a TypeScript class or interface. */
class ClassExtractor {
  constructor(
      protected declaration: ClassDeclaration&ClassDeclarationLike,
      protected typeChecker: ts.TypeChecker,
  ) {}

  /** Extract docs info specific to classes. */
  extract(): ClassEntry {
    return {
      name: this.declaration.name.text,
      isAbstract: this.isAbstract(),
      entryType: ts.isInterfaceDeclaration(this.declaration) ? EntryType.Interface :
                                                               EntryType.UndecoratedClass,
      members: this.extractAllClassMembers(this.declaration),
      generics: extractGenerics(this.declaration),
      description: extractJsDocDescription(this.declaration),
      jsdocTags: extractJsDocTags(this.declaration),
      rawComment: extractRawJsDoc(this.declaration),
    };
  }

  /** Extracts doc info for a class's members. */
  protected extractAllClassMembers(classDeclaration: ClassDeclarationLike): MemberEntry[] {
    const members: MemberEntry[] = [];

    for (const member of classDeclaration.members) {
      if (this.isMemberExcluded(member)) continue;

      const memberEntry = this.extractClassMember(member);
      if (memberEntry) {
        members.push(memberEntry);
      }
    }

    return members;
  }

  /** Extract docs for a class's members (methods and properties).  */
  protected extractClassMember(memberDeclaration: MemberElement): MemberEntry|undefined {
    if (this.isMethod(memberDeclaration) && !this.isImplementationForOverload(memberDeclaration)) {
      return this.extractMethod(memberDeclaration);
    } else if (this.isProperty(memberDeclaration)) {
      return this.extractClassProperty(memberDeclaration);
    } else if (ts.isAccessor(memberDeclaration)) {
      return this.extractGetterSetter(memberDeclaration);
    }

    // We only expect methods, properties, and accessors. If we encounter something else,
    // return undefined and let the rest of the program filter it out.
    return undefined;
  }

  /** Extracts docs for a class method. */
  protected extractMethod(methodDeclaration: MethodLike): MethodEntry {
    const functionExtractor = new FunctionExtractor(methodDeclaration, this.typeChecker);
    return {
      ...functionExtractor.extract(),
      memberType: MemberType.Method,
      memberTags: this.getMemberTags(methodDeclaration),
    };
  }

  /** Extracts doc info for a property declaration. */
  protected extractClassProperty(propertyDeclaration: PropertyLike): PropertyEntry {
    return {
      name: propertyDeclaration.name.getText(),
      type: extractResolvedTypeString(propertyDeclaration, this.typeChecker),
      memberType: MemberType.Property,
      memberTags: this.getMemberTags(propertyDeclaration),
      description: extractJsDocDescription(propertyDeclaration),
      jsdocTags: extractJsDocTags(propertyDeclaration),
    };
  }

  /** Extracts doc info for an accessor member (getter/setter). */
  protected extractGetterSetter(accessor: ts.AccessorDeclaration): PropertyEntry {
    return {
      ...this.extractClassProperty(accessor),
      memberType: ts.isGetAccessor(accessor) ? MemberType.Getter : MemberType.Setter,
    };
  }

  /** Gets the tags for a member (protected, readonly, static, etc.) */
  protected getMemberTags(member: MethodLike|PropertyLike): MemberTags[] {
    const tags: MemberTags[] = this.getMemberTagsFromModifiers(member.modifiers ?? []);

    if (member.questionToken) {
      tags.push(MemberTags.Optional);
    }

    return tags;
  }

  /** Get the tags for a member that come from the declaration modifiers. */
  private getMemberTagsFromModifiers(mods: Iterable<ts.ModifierLike>): MemberTags[] {
    const tags: MemberTags[] = [];
    for (const mod of mods) {
      const tag = this.getTagForMemberModifier(mod);
      if (tag) tags.push(tag);
    }
    return tags;
  }

  /** Gets the doc tag corresponding to a class member modifier (readonly, protected, etc.). */
  private getTagForMemberModifier(mod: ts.ModifierLike): MemberTags|undefined {
    switch (mod.kind) {
      case ts.SyntaxKind.StaticKeyword:
        return MemberTags.Static;
      case ts.SyntaxKind.ReadonlyKeyword:
        return MemberTags.Readonly;
      case ts.SyntaxKind.ProtectedKeyword:
        return MemberTags.Protected;
      case ts.SyntaxKind.AbstractKeyword:
        return MemberTags.Abstract;
      default:
        return undefined;
    }
  }

  /**
   * Gets whether a given class member should be excluded from public API docs.
   * This is the case if:
   *  - The member does not have a name
   *  - The member is neither a method nor property
   *  - The member is private
   *  - The member has a name that marks it as Angular-internal.
   */
  private isMemberExcluded(member: MemberElement): boolean {
    return !member.name || !this.isDocumentableMember(member) ||
        !!member.modifiers?.some(mod => mod.kind === ts.SyntaxKind.PrivateKeyword) ||
        isAngularPrivateName(member.name.getText());
  }

  /** Gets whether a class member is a method, property, or accessor. */
  private isDocumentableMember(member: MemberElement): member is MethodLike|PropertyLike {
    return this.isMethod(member) || this.isProperty(member) || ts.isAccessor(member);
  }

  /** Gets whether a member is a property. */
  private isProperty(member: MemberElement): member is PropertyLike {
    // Classes have declarations, interface have signatures
    return ts.isPropertyDeclaration(member) || ts.isPropertySignature(member);
  }

  /** Gets whether a member is a method. */
  private isMethod(member: MemberElement): member is MethodLike {
    // Classes have declarations, interface have signatures
    return ts.isMethodDeclaration(member) || ts.isMethodSignature(member);
  }

  /** Gets whether the declaration for this extractor is abstract. */
  private isAbstract(): boolean {
    const modifiers = this.declaration.modifiers ?? [];
    return modifiers.some(mod => mod.kind === ts.SyntaxKind.AbstractKeyword);
  }

  /** Gets whether a method is the concrete implementation for an overloaded function. */
  private isImplementationForOverload(method: MethodLike): boolean {
    // Method signatures (in an interface) are never implementations.
    if (method.kind === ts.SyntaxKind.MethodSignature) return false;

    const methodsWithSameName =
        this.declaration.members.filter(member => member.name?.getText() === method.name.getText())
            .sort((a, b) => a.pos - b.pos);

    // No overloads.
    if (methodsWithSameName.length === 1) return false;

    // The implementation is always the last declaration, so we know this is the
    // implementation if it's the last position.
    return method.pos === methodsWithSameName[methodsWithSameName.length - 1].pos;
  }
}

/** Extractor to pull info for API reference documentation for an Angular directive. */
class DirectiveExtractor extends ClassExtractor {
  constructor(
      declaration: ClassDeclaration&ts.ClassDeclaration,
      protected reference: Reference,
      protected metadata: DirectiveMeta,
      checker: ts.TypeChecker,
  ) {
    super(declaration, checker);
  }

  /** Extract docs info for directives and components (including underlying class info). */
  override extract(): DirectiveEntry {
    return {
      ...super.extract(),
      isStandalone: this.metadata.isStandalone,
      selector: this.metadata.selector ?? '',
      exportAs: this.metadata.exportAs ?? [],
      entryType: this.metadata.isComponent ? EntryType.Component : EntryType.Directive,
    };
  }

  /** Extracts docs info for a directive property, including input/output metadata. */
  override extractClassProperty(propertyDeclaration: ts.PropertyDeclaration): PropertyEntry {
    const entry = super.extractClassProperty(propertyDeclaration);

    const inputMetadata = this.getInputMetadata(propertyDeclaration);
    if (inputMetadata) {
      entry.memberTags.push(MemberTags.Input);
      entry.inputAlias = inputMetadata.bindingPropertyName;
      entry.isRequiredInput = inputMetadata.required;
    }

    const outputMetadata = this.getOutputMetadata(propertyDeclaration);
    if (outputMetadata) {
      entry.memberTags.push(MemberTags.Output);
      entry.outputAlias = outputMetadata.bindingPropertyName;
    }

    return entry;
  }

  /** Gets the input metadata for a directive property. */
  private getInputMetadata(prop: ts.PropertyDeclaration): InputMapping|undefined {
    const propName = prop.name.getText();
    return this.metadata.inputs?.getByClassPropertyName(propName) ?? undefined;
  }

  /** Gets the output metadata for a directive property. */
  private getOutputMetadata(prop: ts.PropertyDeclaration): InputOrOutput|undefined {
    const propName = prop.name.getText();
    return this.metadata?.outputs?.getByClassPropertyName(propName) ?? undefined;
  }
}

/** Extractor to pull info for API reference documentation for an Angular pipe. */
class PipeExtractor extends ClassExtractor {
  constructor(
      declaration: ClassDeclaration&ts.ClassDeclaration,
      protected reference: Reference,
      private metadata: PipeMeta,
      typeChecker: ts.TypeChecker,
  ) {
    super(declaration, typeChecker);
  }

  override extract(): PipeEntry {
    return {
      ...super.extract(),
      pipeName: this.metadata.name,
      entryType: EntryType.Pipe,
      isStandalone: this.metadata.isStandalone,
    };
  }
}

/** Extractor to pull info for API reference documentation for an Angular pipe. */
class NgModuleExtractor extends ClassExtractor {
  constructor(
      declaration: ClassDeclaration&ts.ClassDeclaration,
      protected reference: Reference,
      private metadata: NgModuleMeta,
      typeChecker: ts.TypeChecker,
  ) {
    super(declaration, typeChecker);
  }

  override extract(): ClassEntry {
    return {
      ...super.extract(),
      entryType: EntryType.NgModule,
    };
  }
}

/** Extracts documentation info for a class, potentially including Angular-specific info.  */
export function extractClass(
    classDeclaration: ClassDeclaration&ts.ClassDeclaration,
    metadataReader: MetadataReader,
    typeChecker: ts.TypeChecker,
    ): ClassEntry {
  const ref = new Reference(classDeclaration);

  let extractor: ClassExtractor;

  let directiveMetadata = metadataReader.getDirectiveMetadata(ref);
  let pipeMetadata = metadataReader.getPipeMetadata(ref);
  let ngModuleMetadata = metadataReader.getNgModuleMetadata(ref);

  if (directiveMetadata) {
    extractor = new DirectiveExtractor(classDeclaration, ref, directiveMetadata, typeChecker);
  } else if (pipeMetadata) {
    extractor = new PipeExtractor(classDeclaration, ref, pipeMetadata, typeChecker);
  } else if (ngModuleMetadata) {
    extractor = new NgModuleExtractor(classDeclaration, ref, ngModuleMetadata, typeChecker);
  } else {
    extractor = new ClassExtractor(classDeclaration, typeChecker);
  }

  return extractor.extract();
}

/** Extracts documentation info for an interface. */
export function extractInterface(
    declaration: ts.InterfaceDeclaration,
    typeChecker: ts.TypeChecker,
    ): InterfaceEntry {
  const extractor = new ClassExtractor(declaration, typeChecker);
  return extractor.extract();
}
